import { Injectable, HttpException } from '@nestjs/common';

@Injectable()
export class LineService {
  private readonly api = 'https://api.line.me/v2/bot/message/push';
  private readonly token = process.env.LINE_CHANNEL_ACCESS_TOKEN!;

  async pushText(to: string, text: string) {
    const res = await fetch(this.api, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
    });
    if (!res.ok) throw new HttpException(await res.text(), res.status);
  }
}
