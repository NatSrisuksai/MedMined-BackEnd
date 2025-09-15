import { Module } from '@nestjs/common';
import { LineWebhookController } from './line-webhook.controller';
import { PrismaModule } from 'src/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [LineWebhookController],
  providers: [],
})
export class LineWebHookModule {}
