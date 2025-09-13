import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { LineWebHookModule } from './line-webhook/line-webhook.module';
import { LineWebhookController } from './line-webhook/line-webhook.controller';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), LineWebHookModule],
  controllers: [AppController, LineWebhookController],
  providers: [AppService],
})
export class AppModule {}
