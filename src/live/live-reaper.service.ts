import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LiveService } from './live.service';

/**
 * Closes broadcasts whose host is no longer there.
 *
 * Reported as: "the live still continues even after closing the app."
 *
 * Ending a broadcast was something the host's app had to ask for, and a force
 * close never asks. Neither does a crash, a flat battery, or the OS reclaiming
 * the app in the background. The session stayed standing, the live ring stayed
 * lit on everyone's home screen, and every member who tapped it walked into an
 * empty room. The only backstop was a six-hour cut-off, which is to say: most
 * of a day.
 *
 * The host's screen now stamps the session every 20 seconds while it is live,
 * and this closes out anything that has gone quiet for two minutes — properly,
 * with an endedAt, so it reads as recently ended and the was-just-live ring
 * behaves exactly as it does after a normal End.
 */
@Injectable()
export class LiveReaperService {
  private readonly logger = new Logger(LiveReaperService.name);

  constructor(private readonly live: LiveService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async run(): Promise<void> {
    try {
      const closed = await this.live.reapAbandoned();
      if (closed > 0) {
        this.logger.log(`Closed ${closed} broadcast(s) whose host had gone.`);
      }
    } catch (err) {
      // A failed pass is not worth crashing the scheduler over; the next one
      // is a minute away and the query is idempotent.
      this.logger.warn(`Reaper pass failed: ${err}`);
    }
  }
}
