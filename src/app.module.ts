import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { LineWebHookModule } from './line-webhook/line-webhook.module';
import { LineWebhookController } from './line-webhook/line-webhook.controller';
import { PrismaService } from './prisma/prisma.service';
import { PrescriptionsController } from './prescriptions/prescriptions.controller';
import { LineService } from './line/line.service';
import { CronController } from './cron/cron.controller';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), LineWebHookModule],
  controllers: [
    AppController,
    LineWebhookController,
    PrescriptionsController,
    CronController,
  ],
  providers: [AppService, PrismaService, LineService],
})
export class AppModule {}
