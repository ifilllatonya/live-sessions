import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';

/**
 * Real-time fan-out for a broadcast.
 *
 * One Socket.IO room per session, so a comment costs one emit to the people
 * actually watching rather than a broadcast to everyone connected. The
 * gateway deliberately holds no business logic: the service writes, then
 * asks the gateway to tell the room. That keeps the rules testable without
 * standing up a socket server.
 */
@WebSocketGateway({ namespace: '/live', cors: { origin: '*' } })
export class LiveGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(LiveGateway.name);

  handleConnection(client: Socket) {
    this.logger.debug(`connected ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`disconnected ${client.id}`);
  }

  @SubscribeMessage('join')
  join(@MessageBody() body: { sessionId: string }, @ConnectedSocket() client: Socket) {
    client.join(room(body.sessionId));
    // Viewer count is read off the room itself rather than tracked separately,
    // so a dropped connection cannot leave a phantom viewer behind.
    this.emitViewers(body.sessionId);
    return { ok: true };
  }

  @SubscribeMessage('leave')
  leave(@MessageBody() body: { sessionId: string }, @ConnectedSocket() client: Socket) {
    client.leave(room(body.sessionId));
    this.emitViewers(body.sessionId);
    return { ok: true };
  }

  comment(sessionId: string, payload: unknown) {
    this.server?.to(room(sessionId)).emit('comment', payload);
  }

  reaction(sessionId: string, payload: unknown) {
    this.server?.to(room(sessionId)).emit('reaction', payload);
  }

  guestChanged(sessionId: string, payload: unknown) {
    this.server?.to(room(sessionId)).emit('guest', payload);
  }

  /** Tell the room it is over, so viewers leave rather than stare at a frozen frame. */
  ended(sessionId: string) {
    this.server?.to(room(sessionId)).emit('ended', { sessionId });
  }

  private emitViewers(sessionId: string) {
    const size = this.server?.sockets?.adapter?.rooms?.get(room(sessionId))?.size ?? 0;
    this.server?.to(room(sessionId)).emit('viewers', { sessionId, viewers: size });
  }
}

const room = (sessionId: string) => `live:${sessionId}`;
