import { Controller, Post, Req, Res } from '@nestjs/common';
import * as crypto from 'crypto';

@Controller('webhook/line')
export class LineWebhookController {
  @Post()
  async handle(@Req() req: any, @Res() res: any) {
    const signature = req.headers['x-line-signature'] as string;
    const raw: Buffer = req.rawBody;

    if (!raw) return res.status(400).send('Raw body missing');
    if (!signature) return res.status(400).send('Missing x-line-signature');

    const expected = crypto
      .createHmac('sha256', process.env.LINE_CHANNEL_SECRET!)
      .update(raw)
      .digest('base64');

    if (expected !== signature)
      return res.status(403).send('Invalid signature');

    // const body = JSON.parse(raw.toString('utf8'));
    // TODO: จัดการ follow/message/postback ตามต้องการ
    // ตัวอย่าง: ถ้ามี auto-reply ให้ส่งปุ่ม "ยืนยันใบยา" (เปิด LIFF เดิม)

    return res.status(200).send('OK');
  }
}
