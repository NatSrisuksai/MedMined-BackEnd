import { Module } from '@nestjs/common';
import { LineWebhookController } from './line-webhook.controller';

@Module({
  imports: [],
  controllers: [LineWebhookController],
  providers: [],
})
export class LineWebHookModule {}
