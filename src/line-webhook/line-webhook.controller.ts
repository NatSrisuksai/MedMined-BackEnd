import { Controller, Post, Req, Res, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';

@Controller('webhook/line')
export class LineWebhookController {
  private readonly logger = new Logger(LineWebhookController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Post()
  async handle(@Req() req: any, @Res() res: any) {
    // --- verify signature ---
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

    // --- parse events ---
    const body = JSON.parse(raw.toString('utf8'));
    const events = body.events || [];

    for (const ev of events) {
      try {
        // ✅ รองรับปุ่ม Rich Menu แบบ "ข้อความ" จาก OA Manager (ข้อความ: คลังยา)
        if (ev.type === 'message' && ev.message?.type === 'text') {
          await this.onText(ev);
          continue;
        }

        // (ยังรองรับ postback กรณีคุณสร้างเมนูผ่าน Messaging API ในอนาคต)
        if (ev.type === 'postback' && ev.postback?.data) {
          await this.onPostback(ev);
          continue;
        }

        // เพิ่มเติม: follow/message อื่น ๆ ได้ตามต้องการ
      } catch (err) {
        // swallow error per event เพื่อไม่ให้ทั้ง batch fail
        this.logger.error('Webhook event error', err as any);
      }
    }

    return res.status(200).send('OK');
  }

  // --------------------------
  // ❶ onText(): ปุ่ม Rich Menu แบบ "ข้อความ"
  // OA Manager → Rich menu → ปุ่ม "ข้อความ" → ใส่คำว่า "คลังยา"
  // ผู้ใช้กดแล้ว OA จะส่ง message event (text="คลังยา") มาที่ webhook
  // --------------------------
  private async onText(ev: any) {
    const lineUserId = ev?.source?.userId;
    if (!lineUserId) return;

    const text: string = String(ev.message?.text || '').trim();

    // ปรับได้ตามที่ตั้งข้อความบนปุ่ม ถ้าอยากรองรับหลายคำก็เพิ่มใน array
    const triggers = ['คลังยา'];
    if (!triggers.includes(text)) return;

    const patient = await this.prisma.patient.findFirst({
      where: { lineUserId },
      select: { id: true, recentActivatedPrescriptionId: true },
    });

    if (!patient?.recentActivatedPrescriptionId) {
      await this.replyTo(
        ev.replyToken,
        'ยังไม่มีใบยาล่าสุด โปรดสแกน QR ใบยาก่อน',
      );
      return;
    }

    const rxId = patient.recentActivatedPrescriptionId;

    // upsert เข้าคลังยา + เปิดแจ้งเตือน
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
  }

  // --------------------------
  // ❷ onPostback(): เผื่อคุณใช้ Rich Menu แบบ postback ผ่าน Messaging API
  // --------------------------
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

  // --------------------------
  // ❸ reply helper
  // --------------------------
  private async replyTo(replyToken: string, text: string) {
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
