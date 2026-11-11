import { ForbiddenException } from '@nestjs/common';
import { LiveService, HOST_GRACE_MS, LEGACY_GRACE_MS, Actor } from '../src/live/live.service';

const NOW = new Date('2026-03-01T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const host: Actor = { id: 'host-1', name: 'Host' };
const viewer: Actor = { id: 'viewer-1', name: 'Viewer' };

function mockPrisma() {
  return {
    liveSession: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    liveComment: { findUnique: jest.fn(), create: jest.fn() },
    liveReaction: { create: jest.fn() },
    liveCommentReaction: { findUnique: jest.fn(), create: jest.fn(), delete: jest.fn() },
    liveGuest: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

describe('LiveService.reapAbandoned', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let service: LiveService;

  beforeEach(() => {
    prisma = mockPrisma();
    service = new LiveService(prisma as never);
  });

  it('closes a broadcast whose host stopped beating', async () => {
    prisma.liveSession.findMany.mockResolvedValue([{ id: 's1' }]);

    const closed = await service.reapAbandoned(NOW);

    expect(closed).toBe(1);
    expect(prisma.liveSession.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['s1'] } },
      data: { isActive: false, isLive: false, endedAt: NOW },
    });
  });

  it('sets endedAt rather than leaving it null, so the session reads as recently ended', async () => {
    prisma.liveSession.findMany.mockResolvedValue([{ id: 's1' }]);
    await service.reapAbandoned(NOW);
    const { data } = prisma.liveSession.updateMany.mock.calls[0][0];
    expect(data.endedAt).toEqual(NOW);
  });

  it('does nothing when every host is still beating', async () => {
    prisma.liveSession.findMany.mockResolvedValue([]);
    expect(await service.reapAbandoned(NOW)).toBe(0);
    expect(prisma.liveSession.updateMany).not.toHaveBeenCalled();
  });

  it('asks for beats older than the grace window, and only for live sessions', async () => {
    await service.reapAbandoned(NOW);
    const { where } = prisma.liveSession.findMany.mock.calls[0][0];

    expect(where.isActive).toBe(true);
    expect(where.OR[0].lastHostBeatAt.lt).toEqual(ago(HOST_GRACE_MS));
  });

  it('gives pre-heartbeat sessions the long rope, so deploying cannot kill a live broadcast', async () => {
    await service.reapAbandoned(NOW);
    const { where } = prisma.liveSession.findMany.mock.calls[0][0];
    const legacy = where.OR[1];

    expect(legacy.lastHostBeatAt).toBeNull();
    expect(legacy.startedAt.lt).toEqual(ago(LEGACY_GRACE_MS));
    // A session with no beat that started an hour ago must survive.
    expect(ago(60 * 60 * 1000) > legacy.startedAt.lt).toBe(true);
  });

  it('ends the guests before closing the session', async () => {
    prisma.liveSession.findMany.mockResolvedValue([{ id: 's1' }]);
    await service.reapAbandoned(NOW);

    expect(prisma.liveGuest.updateMany).toHaveBeenCalledWith({
      where: { sessionId: { in: ['s1'] }, status: { in: ['ACTIVE', 'INVITED'] } },
      data: { status: 'ENDED', endedAt: NOW },
    });
    expect(prisma.liveGuest.updateMany.mock.invocationCallOrder[0])
      .toBeLessThan(prisma.liveSession.updateMany.mock.invocationCallOrder[0]);
  });

  it('still closes the session when clearing guests fails', async () => {
    prisma.liveSession.findMany.mockResolvedValue([{ id: 's1' }]);
    prisma.liveGuest.updateMany.mockRejectedValue(new Error('db blipped'));

    await expect(service.reapAbandoned(NOW)).resolves.toBe(1);
    expect(prisma.liveSession.updateMany).toHaveBeenCalled();
  });
});

describe('LiveService.hostHeartbeat', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let service: LiveService;

  beforeEach(() => {
    prisma = mockPrisma();
    service = new LiveService(prisma as never);
  });

  it('only counts the host’s own beat on a session still running', async () => {
    prisma.liveSession.updateMany.mockResolvedValue({ count: 1 });

    await service.hostHeartbeat('s1', 'host-1');

    expect(prisma.liveSession.updateMany.mock.calls[0][0].where).toEqual({
      id: 's1',
      hostId: 'host-1',
      isActive: true,
    });
  });

  it('reports not-ok when the beat matched nothing, so a viewer cannot prop up a broadcast', async () => {
    prisma.liveSession.updateMany.mockResolvedValue({ count: 0 });
    expect(await service.hostHeartbeat('s1', 'viewer-1')).toEqual({ ok: false });
  });

  it('never throws out of a heartbeat', async () => {
    prisma.liveSession.updateMany.mockRejectedValue(new Error('db down'));
    await expect(service.hostHeartbeat('s1', 'host-1')).resolves.toEqual({ ok: false });
  });
});

describe('LiveService.reactToComment', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let service: LiveService;

  beforeEach(() => {
    prisma = mockPrisma();
    service = new LiveService(prisma as never);
  });

  it('adds the reaction the first time', async () => {
    prisma.liveCommentReaction.findUnique.mockResolvedValue(null);
    expect(await service.reactToComment('c1', 'u1', '🔥')).toEqual({ reacted: true });
    expect(prisma.liveCommentReaction.create).toHaveBeenCalled();
  });

  it('takes it back on the second tap', async () => {
    prisma.liveCommentReaction.findUnique.mockResolvedValue({ id: 'r1' });
    expect(await service.reactToComment('c1', 'u1', '🔥')).toEqual({ reacted: false });
    expect(prisma.liveCommentReaction.delete).toHaveBeenCalledWith({ where: { id: 'r1' } });
  });
});

describe('LiveService.stop', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let service: LiveService;

  beforeEach(() => {
    prisma = mockPrisma();
    service = new LiveService(prisma as never);
  });

  it('refuses anyone who is neither the host nor an admin', async () => {
    prisma.liveSession.findUnique.mockResolvedValue({ id: 's1', hostId: host.id, isActive: true });
    await expect(service.stop('s1', viewer)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets an admin end someone else’s broadcast', async () => {
    prisma.liveSession.findUnique.mockResolvedValue({ id: 's1', hostId: host.id, isActive: true });
    prisma.liveSession.update.mockResolvedValue({ id: 's1', isActive: false });

    await service.stop('s1', { ...viewer, role: 'ADMIN' });

    expect(prisma.liveSession.update).toHaveBeenCalled();
  });

  it('is a no-op on a broadcast that already ended', async () => {
    prisma.liveSession.findUnique.mockResolvedValue({ id: 's1', hostId: host.id, isActive: false });
    await service.stop('s1', host);
    expect(prisma.liveSession.update).not.toHaveBeenCalled();
  });
});
