import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { LiveService, Actor } from './live.service';
import { LiveGateway } from './live.gateway';

/**
 * HTTP surface for a broadcast.
 *
 * Writes go through here and the result is pushed to the room by the gateway,
 * rather than clients emitting straight over the socket. One path in means one
 * place where the rules live, and a client that loses its socket still works.
 *
 * `actor` arrives from the auth guard in the real deployment; it is taken from
 * the body here so the repo runs without an identity provider attached.
 */
@Controller('live')
export class LiveController {
  constructor(
    private readonly live: LiveService,
    private readonly gateway: LiveGateway,
  ) {}

  @Get()
  listActive() {
    return this.live.listActive();
  }

  @Post('start')
  start(@Body() body: { actor: Actor; title?: string }) {
    return this.live.start(body.actor, body.title);
  }

  /** Called by the host's screen every 20 seconds while it is live. */
  @Post(':id/heartbeat')
  heartbeat(@Param('id') id: string, @Body() body: { userId: string }) {
    return this.live.hostHeartbeat(id, body.userId);
  }

  @Post(':id/stop')
  async stop(@Param('id') id: string, @Body() body: { actor: Actor }) {
    const session = await this.live.stop(id, body.actor);
    this.gateway.ended(id);
    return session;
  }

  @Post(':id/comments')
  async comment(
    @Param('id') id: string,
    @Body() body: { actor: Actor; text: string; replyToId?: string },
  ) {
    const comment = await this.live.addComment(id, body.actor, body.text, body.replyToId);
    this.gateway.comment(id, comment);
    return comment;
  }

  @Post(':id/reactions')
  async react(@Param('id') id: string, @Body() body: { emoji: string }) {
    const reaction = await this.live.addReaction(id, body.emoji);
    this.gateway.reaction(id, reaction);
    return reaction;
  }

  @Post(':id/comments/:commentId/reactions')
  async reactToComment(
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @Body() body: { userId: string; emoji: string },
  ) {
    const result = await this.live.reactToComment(commentId, body.userId, body.emoji);
    this.gateway.comment(id, { commentId, ...result });
    return result;
  }

  @Get(':id/guests')
  guests(@Param('id') id: string) {
    return this.live.guests(id);
  }

  @Post(':id/guests')
  async invite(@Param('id') id: string, @Body() body: { host: Actor; guest: Actor }) {
    const guest = await this.live.inviteGuest(id, body.host, body.guest);
    this.gateway.guestChanged(id, guest);
    return guest;
  }

  @Post(':id/guests/accept')
  async accept(@Param('id') id: string, @Body() body: { userId: string }) {
    const guest = await this.live.acceptGuest(id, body.userId);
    this.gateway.guestChanged(id, guest);
    return guest;
  }

  @Post(':id/guests/decline')
  decline(@Param('id') id: string, @Body() body: { userId: string }) {
    return this.live.declineGuest(id, body.userId);
  }

  @Delete(':id/guests/:userId')
  async endGuest(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() body: { actor: Actor },
  ) {
    const guest = await this.live.endGuest(id, body.actor, userId);
    this.gateway.guestChanged(id, guest);
    return guest;
  }
}
