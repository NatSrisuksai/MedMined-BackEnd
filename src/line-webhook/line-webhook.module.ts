import { Module } from '@nestjs/common';
import { LineWebhookController } from './line-webhook.controller';
import { PrismaService } from 'src/prisma/prisma.service';

@Module({
  imports: [PrismaService],
  controllers: [LineWebhookController],
  providers: [],
})
export class LineWebHookModule {}
