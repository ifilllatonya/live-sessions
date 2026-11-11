import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { LiveModule } from './live/live.module';

@Module({
  imports: [ScheduleModule.forRoot(), PrismaModule, LiveModule],
})
export class AppModule {}
