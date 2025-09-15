import { Controller, Post, Req, Res } from '@nestjs/common';
import * as crypto from 'crypto';
import { LineService } from 'src/line/line.service';
import { PrismaService } from 'src/prisma/prisma.service';

@Controller('webhook/line')
export class LineWebhookController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly line: LineService,
  ) {}

  @Post()
  async handle(@Req() req: any, @Res() res: any) {
    // verify signature
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

    const body = JSON.parse(raw.toString('utf8'));
    const events = body.events || [];

    for (const ev of events) {
      try {
        if (ev.type === 'postback' && ev.postback?.data) {
          await this.onPostback(ev);
        }
        // อื่นๆ เช่น follow/message ถ้าต้องการ
      } catch (err) {
        // swallow error per event เพื่อไม่ให้ทั้ง batch fail
        console.error('Webhook event error', err);
      }
    }

    return res.status(200).send('OK');
  }

  private async onPostback(ev: any) {
    const data = String(ev.postback.data || '');
    const lineUserId = ev.source?.userId;
    if (!lineUserId) return;

    // หา patient จาก lineUserId
    const patient = await this.prisma.patient.findFirst({
      where: { lineUserId },
      select: { id: true, fullName: true, recentActivatedPrescriptionId: true },
    });
    if (!patient) {
      await this.replyTo(
        ev.replyToken,
        'ยังไม่พบบัญชีผู้ใช้ โปรดสแกน QR ใบยาก่อน',
      );
      return;
    }

    if (data === 'inventory_save_last') {
      const rxId = patient.recentActivatedPrescriptionId;
      if (!rxId) {
        await this.replyTo(
          ev.replyToken,
          'ยังไม่มีใบยาล่าสุด โปรดสแกน QR ใบยาก่อน',
        );
        return;
      }

      // upsert เข้าคลังยา
      await this.prisma.medicationInventory.upsert({
        where: {
          patientId_prescriptionId: {
            patientId: patient.id,
            prescriptionId: rxId,
          },
        },
        create: { patientId: patient.id, prescriptionId: rxId, isActive: true },
        update: { isActive: true },
      });

      // ดึงชื่อยาเพื่อแจ้งกลับ
      const rx = await this.prisma.prescription.findUnique({
        where: { id: rxId },
        select: { drugName: true, strength: true },
      });

      await this.replyTo(
        ev.replyToken,
        `บันทึกเข้าคลังยาแล้ว: ${rx?.drugName}${rx?.strength ? ` (${rx.strength})` : ''}`,
      );
      return;
    }

    if (data === 'inventory_open') {
      // (ออปชัน) ส่ง Flex รายการใบยาทั้งหมดของคนๆ นี้ให้กดเลือก
      // คุณสามารถดึง prescriptions ของ patient.id แล้วส่ง Flex carousel ใส่ postback data เช่น "inventory_toggle:<rxId>"
      await this.replyTo(ev.replyToken, 'กำลังพัฒนาเมนูเลือกหลายใบยา 😉');
      return;
    }

    if (data.startsWith('inventory_toggle:')) {
      const rxId = data.split(':')[1];
      if (!rxId) return;

      const exist = await this.prisma.medicationInventory.findUnique({
        where: {
          patientId_prescriptionId: {
            patientId: patient.id,
            prescriptionId: rxId,
          },
        },
      });

      if (exist?.isActive) {
        await this.prisma.medicationInventory.update({
          where: {
            patientId_prescriptionId: {
              patientId: patient.id,
              prescriptionId: rxId,
            },
          },
          data: { isActive: false },
        });
        await this.replyTo(ev.replyToken, 'ปิดแจ้งเตือนยารายการนี้แล้ว');
      } else if (exist) {
        await this.prisma.medicationInventory.update({
          where: {
            patientId_prescriptionId: {
              patientId: patient.id,
              prescriptionId: rxId,
            },
          },
          data: { isActive: true },
        });
        await this.replyTo(ev.replyToken, 'เปิดแจ้งเตือนยารายการนี้แล้ว');
      } else {
        await this.prisma.medicationInventory.create({
          data: { patientId: patient.id, prescriptionId: rxId, isActive: true },
        });
        await this.replyTo(
          ev.replyToken,
          'บันทึกเข้าคลังยาและเปิดแจ้งเตือนแล้ว',
        );
      }
      return;
    }
  }

  private async replyTo(replyToken: string, text: string) {
    // ใช้ reply API หรือจะ push ก็ได้
    await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        replyToken,
        messages: [{ type: 'text', text }],
      }),
    });
  }
}
