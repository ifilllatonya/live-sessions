import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** How long the host may go quiet before the broadcast is closed for them. */
export const HOST_GRACE_MS = 2 * 60 * 1000;

/**
 * Sessions that started before heartbeats existed have no beat at all. They
 * get the old six-hour rope instead of being closed on the first pass, so
 * shipping the reaper cannot end a broadcast that is genuinely on air.
 */
export const LEGACY_GRACE_MS = 6 * 60 * 60 * 1000;

/** One emoji, not an essay. Reactions are rendered as a single glyph. */
const MAX_EMOJI_LENGTH = 8;
const MAX_COMMENT_LENGTH = 500;

export interface Actor {
  id: string;
  name: string;
  avatarUrl?: string | null;
  role?: string | null;
}

@Injectable()
export class LiveService {
  constructor(private readonly prisma: PrismaService) {}

  /** Open a broadcast. One live session per host at a time. */
  async start(host: Actor, title?: string) {
    const existing = await this.prisma.liveSession.findFirst({
      where: { hostId: host.id, isActive: true },
    });
    if (existing) return existing;

    return this.prisma.liveSession.create({
      data: {
        hostId: host.id,
        hostName: host.name,
        hostAvatarUrl: host.avatarUrl ?? null,
        roomName: `room_${host.id}_${Date.now()}`,
        title: title?.trim() || null,
        isActive: true,
        isLive: true,
        lastHostBeatAt: new Date(),
      },
    });
  }

  /**
   * The host's screen stamps the session every 20 seconds while it is live.
   *
   * Scoped to the host's own active session on purpose: a viewer cannot keep
   * somebody else's broadcast standing, and a beat for an ended session is a
   * no-op rather than a resurrection.
   */
  async hostHeartbeat(sessionId: string, userId: string): Promise<{ ok: boolean }> {
    try {
      const { count } = await this.prisma.liveSession.updateMany({
        where: { id: sessionId, hostId: userId, isActive: true },
        data: { lastHostBeatAt: new Date() },
      });
      return { ok: count > 0 };
    } catch {
      return { ok: false };
    }
  }

  /**
   * Close broadcasts whose host has stopped saying they are there.
   *
   * Ending a broadcast is something the host's app has to ask for. A force
   * close never asks, and neither does a crash, a flat battery, or the OS
   * reclaiming the app in the background. Without this the session stays
   * standing, the live ring stays lit, and everyone who taps it walks into
   * an empty room.
   *
   * The grace is generous next to the 20-second beat because the two
   * mistakes do not cost the same: ending a real broadcast because the host
   * walked behind a wall is far worse than a stale ring lasting one more
   * minute.
   *
   * Returns how many were closed.
   */
  async reapAbandoned(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - HOST_GRACE_MS);
    const legacyCutoff = new Date(now.getTime() - LEGACY_GRACE_MS);

    const stale = await this.prisma.liveSession.findMany({
      where: {
        isActive: true,
        OR: [
          { lastHostBeatAt: { lt: cutoff } },
          { lastHostBeatAt: null, startedAt: { lt: legacyCutoff } },
        ],
      },
      select: { id: true },
    });
    if (stale.length === 0) return 0;

    const ids = stale.map((s) => s.id);

    // Guests are closed out first so nobody is left holding a camera slot on
    // a dead broadcast. Deliberately swallowed: a failure here must never
    // stop the session itself being closed.
    await this.prisma.liveGuest
      .updateMany({
        where: { sessionId: { in: ids }, status: { in: ['ACTIVE', 'INVITED'] } },
        data: { status: 'ENDED', endedAt: now },
      })
      .catch(() => undefined);

    await this.prisma.liveSession.updateMany({
      where: { id: { in: ids } },
      // endedAt is set rather than left null so these read as "recently
      // ended" and the was-just-live ring behaves as it does after a
      // normal End.
      data: { isActive: false, isLive: false, endedAt: now },
    });

    return stale.length;
  }

  /** End a broadcast. Host or admin only. */
  async stop(sessionId: string, actor: Actor) {
    const session = await this.prisma.liveSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('No such broadcast.');
    if (session.hostId !== actor.id && actor.role !== 'ADMIN') {
      throw new ForbiddenException('Only the host can end this broadcast.');
    }
    if (!session.isActive) return session;

    await this.prisma.liveGuest
      .updateMany({
        where: { sessionId, status: { in: ['ACTIVE', 'INVITED'] } },
        data: { status: 'ENDED', endedAt: new Date() },
      })
      .catch(() => undefined);

    return this.prisma.liveSession.update({
      where: { id: sessionId },
      data: { isActive: false, isLive: false, endedAt: new Date() },
    });
  }

  async listActive() {
    return this.prisma.liveSession.findMany({
      where: { isActive: true },
      orderBy: { startedAt: 'desc' },
    });
  }

  /** Post a comment, optionally quoting one already on the broadcast. */
  async addComment(sessionId: string, author: Actor, textRaw: string, replyToId?: string) {
    const text = textRaw.trim().slice(0, MAX_COMMENT_LENGTH);
    if (!text) throw new NotFoundException('A comment needs some text.');

    const session = await this.prisma.liveSession.findUnique({ where: { id: sessionId } });
    if (!session || !session.isActive) throw new NotFoundException('That broadcast has ended.');

    // The quoted parent is snapshotted, not joined, so the reply still reads
    // correctly if the parent is later removed.
    let replyToName: string | null = null;
    let replyToText: string | null = null;
    if (replyToId) {
      const parent = await this.prisma.liveComment.findUnique({ where: { id: replyToId } });
      if (parent && parent.sessionId === sessionId) {
        replyToName = parent.userName;
        replyToText = parent.text.slice(0, 120);
      } else {
        replyToId = undefined;
      }
    }

    return this.prisma.liveComment.create({
      data: {
        sessionId,
        userId: author.id,
        userName: author.name,
        userAvatarUrl: author.avatarUrl ?? null,
        text,
        replyToId: replyToId ?? null,
        replyToName,
        replyToText,
      },
    });
  }

  /** A floating emoji on the broadcast. Not deduplicated: volume is the point. */
  async addReaction(sessionId: string, emojiRaw: string) {
    const emoji = emojiRaw.trim().slice(0, MAX_EMOJI_LENGTH);
    if (!emoji) throw new NotFoundException('A reaction needs an emoji.');
    return this.prisma.liveReaction.create({ data: { sessionId, emoji } });
  }

  /**
   * React to a comment, or take the reaction back.
   *
   * The unique constraint on (comment, user, emoji) is what makes this a
   * toggle instead of a counter that only goes up: the same tap twice
   * removes the row.
   */
  async reactToComment(commentId: string, userId: string, emojiRaw: string) {
    const emoji = emojiRaw.trim().slice(0, MAX_EMOJI_LENGTH);
    if (!emoji) throw new NotFoundException('A reaction needs an emoji.');

    const existing = await this.prisma.liveCommentReaction.findUnique({
      where: { commentId_userId_emoji: { commentId, userId, emoji } },
    });

    if (existing) {
      await this.prisma.liveCommentReaction.delete({ where: { id: existing.id } });
      return { reacted: false };
    }

    await this.prisma.liveCommentReaction.create({ data: { commentId, userId, emoji } });
    return { reacted: true };
  }

  /** Invite someone onto the broadcast as a co-host. Host only. */
  async inviteGuest(sessionId: string, host: Actor, guest: Actor) {
    const session = await this.prisma.liveSession.findUnique({ where: { id: sessionId } });
    if (!session || !session.isActive) throw new NotFoundException('That broadcast has ended.');
    if (session.hostId !== host.id) throw new ForbiddenException('Only the host can invite guests.');

    return this.prisma.liveGuest.upsert({
      where: { sessionId_userId: { sessionId, userId: guest.id } },
      // Re-inviting someone who declined puts them back to INVITED rather
      // than erroring, because on screen that is just asking again.
      update: { status: 'INVITED', invitedAt: new Date(), endedAt: null },
      create: {
        sessionId,
        userId: guest.id,
        userName: guest.name,
        userAvatarUrl: guest.avatarUrl ?? null,
        status: 'INVITED',
      },
    });
  }

  async acceptGuest(sessionId: string, userId: string) {
    const invite = await this.prisma.liveGuest.findUnique({
      where: { sessionId_userId: { sessionId, userId } },
    });
    if (!invite || invite.status !== 'INVITED') {
      throw new NotFoundException('No open invitation for this broadcast.');
    }
    return this.prisma.liveGuest.update({
      where: { id: invite.id },
      data: { status: 'ACTIVE', joinedAt: new Date() },
    });
  }

  async declineGuest(sessionId: string, userId: string) {
    const invite = await this.prisma.liveGuest.findUnique({
      where: { sessionId_userId: { sessionId, userId } },
    });
    if (!invite || invite.status !== 'INVITED') {
      throw new NotFoundException('No open invitation for this broadcast.');
    }
    return this.prisma.liveGuest.update({
      where: { id: invite.id },
      data: { status: 'DECLINED', endedAt: new Date() },
    });
  }

  /** Take a guest off the broadcast. The host may remove anyone; a guest may leave. */
  async endGuest(sessionId: string, actor: Actor, guestUserId: string) {
    const session = await this.prisma.liveSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('No such broadcast.');
    if (session.hostId !== actor.id && actor.id !== guestUserId) {
      throw new ForbiddenException('Only the host can remove another guest.');
    }
    const guest = await this.prisma.liveGuest.findUnique({
      where: { sessionId_userId: { sessionId, userId: guestUserId } },
    });
    if (!guest) throw new NotFoundException('That person is not a guest here.');

    return this.prisma.liveGuest.update({
      where: { id: guest.id },
      data: { status: 'ENDED', endedAt: new Date() },
    });
  }

  async guests(sessionId: string) {
    return this.prisma.liveGuest.findMany({
      where: { sessionId, status: { in: ['INVITED', 'ACTIVE'] } },
      orderBy: { invitedAt: 'asc' },
    });
  }
}
