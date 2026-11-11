import { Module } from '@nestjs/common';
import { LiveController } from './live.controller';
import { LiveService } from './live.service';
import { LiveGateway } from './live.gateway';
import { LiveReaperService } from './live-reaper.service';

@Module({
  controllers: [LiveController],
  providers: [LiveService, LiveGateway, LiveReaperService],
  exports: [LiveService],
})
export class LiveModule {}
