import { HttpException, Injectable } from '@nestjs/common';

@Injectable()
export class LineService {
  private readonly pushApi = 'https://api.line.me/v2/bot/message/push';
  private readonly token = process.env.LINE_CHANNEL_ACCESS_TOKEN!;

  private headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  async pushText(to: string, text: string) {
    const res = await fetch(this.pushApi, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
    });
    if (!res.ok) throw new HttpException(await res.text(), res.status);
  }

  async pushFlex(to: string, altText: string, contents: any) {
    const res = await fetch(this.pushApi, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        to,
        messages: [{ type: 'flex', altText, contents }],
      }),
    });
    if (!res.ok) throw new HttpException(await res.text(), res.status);
  }
}
