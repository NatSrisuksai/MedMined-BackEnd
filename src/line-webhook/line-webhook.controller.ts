import { Controller, Post, Req, Res } from '@nestjs/common';
import * as crypto from 'crypto';

@Controller('webhook/line')
export class LineWebhookController {
  @Post()
  async handle(@Req() req: any, @Res() res: any) {
    const signature = req.headers['x-line-signature'] as string;
    const raw: Buffer = req.rawBody;
    console.log('--- Incoming LINE Webhook ---');
    console.log('has raw?', !!raw, 'raw bytes:', raw?.length);
    console.log('x-line-signature present?', !!signature);
    console.log('raw as text:', raw?.toString('utf8'));

    // (ชั่วคราว) ถ้าไม่มี raw ก็จบเลย
    if (!raw) return res.status(400).send('Raw body missing');

    // คำนวณ expected แล้ว log แค่หัว (กันหลุดทั้งสตริง)
    const hmac = crypto.createHmac('sha256', process.env.LINE_CHANNEL_SECRET!);
    hmac.update(raw);
    const expected = hmac.digest('base64');
    console.log('sig(head):', String(signature).slice(0, 10));
    console.log('exp(head):', expected.slice(0, 10));

    // ช่วงดีบัก: ยังตอบ 200 ไปก่อนเพื่อให้ Verify ผ่าน แล้วดู payload
    // ถ้าอยากเข้าลูปด้านล่าง ให้ comment return นี้หลังดีบักเสร็จ
    // return res.status(200).send('OK')

    if (expected !== signature) {
      console.warn('Signature mismatch');
      // ช่วงดีบัก อนุโลมผ่านไปก่อนเพื่อดู body/events:
      // return res.status(200).send('OK')
      return res.status(403).send('Invalid signature');
    }

    const body = JSON.parse(raw.toString('utf8'));
    console.log('events length:', body.events?.length ?? 0);

    for (const ev of body.events ?? []) {
      console.log('Event type:', ev.type);
      console.log('UserId:', ev.source?.userId);
      console.log('Timestamp:', ev.timestamp);
      if (ev.type === 'message') console.log('Message text:', ev.message?.text);
      if (ev.type === 'follow')
        console.log('User followed OA:', ev.source?.userId);
      if (ev.type === 'unfollow')
        console.log('User unfollowed OA:', ev.source?.userId);
      // TODO: handle/save...
    }

    return res.status(200).send('OK');
  }
}
