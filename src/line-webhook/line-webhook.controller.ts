import { Controller, Post, Req, Res, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';

@Controller('webhook/line')
export class LineWebhookController {
  private readonly logger = new Logger(LineWebhookController.name);

  constructor(private readonly prisma: PrismaService) {}

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
        if (ev.type === 'message' && ev.message?.type === 'text') {
          await this.onText(ev);
          continue;
        }
        if (ev.type === 'postback' && ev.postback?.data) {
          await this.onPostback(ev);
          continue;
        }
      } catch (err) {
        this.logger.error('Webhook event error', err as any);
      }
    }

    return res.status(200).send('OK');
  }

  /** ปุ่ม Rich Menu แบบ “ข้อความ” */
  private async onText(ev: any) {
    const lineUserId = ev?.source?.userId;
    if (!lineUserId) return;
    const text: string = String(ev.message?.text || '').trim();

    // ❶ รับประทานยาแล้ว → ตัดแจ้งเตือน "มื้อที่ถึงเวลาแล้วในวันนี้" + บันทึกการทาน
    if (text === 'รับประทานยาแล้ว') {
      const patient = await this.prisma.patient.findFirst({
        where: { lineUserId },
        select: {
          id: true,
          fullName: true,
        },
      });
      if (!patient) {
        await this.replyTo(
          ev.replyToken,
          'ยังไม่พบบัญชีผู้ใช้ โปรดสแกน QR ใบยาก่อน',
        );
        return;
      }

      // ดึง inventories ที่เปิดอยู่ของผู้ใช้
      const invs = await this.prisma.medicationInventory.findMany({
        where: { patientId: patient.id, isActive: true },
        select: {
          prescription: {
            select: {
              id: true,
              drugName: true,
              timezone: true,
              schedules: {
                where: { isActive: true },
                select: { period: true, hhmm: true, pills: true },
              },
            },
          },
        },
      });

      const takenList: string[] = [];
      for (const inv of invs) {
        const rx = inv.prescription;
        if (!rx) continue;

        const rxTz = rx.timezone || 'Asia/Bangkok';
        const ymd = formatYMDInTz(new Date(), rxTz);
        const nowMin = hhmmToMinutes(formatHHMMInTz(new Date(), rxTz));

        for (const s of rx.schedules) {
          const schedMin = hhmmToMinutes(s.hhmm);
          // เฉพาะมื้อที่ "เลยเวลาแล้วในวันนี้"
          if (nowMin < schedMin) continue;

          const slotDate = ymdToMidnightUTC(ymd);
          const exists = await this.prisma.doseIntake.findUnique({
            where: {
              patientId_prescriptionId_slotDate_hhmm: {
                patientId: patient.id,
                prescriptionId: rx.id,
                slotDate,
                hhmm: s.hhmm,
              },
            },
            select: { id: true },
          });
          if (exists) continue;

          await this.prisma.doseIntake.create({
            data: {
              patientId: patient.id,
              prescriptionId: rx.id,
              slotDate,
              hhmm: s.hhmm,
              pills: s.pills,
            },
          });

          takenList.push(
            `${rx.drugName} — ${periodToThai(s.period)} ${s.hhmm} (${s.pills} เม็ด)`,
          );
        }
      }

      if (takenList.length === 0) {
        await this.replyTo(
          ev.replyToken,
          'ยังไม่พบมื้อที่ถึงเวลาในวันนี้ หรือบันทึกไปแล้ว',
        );
      } else {
        await this.replyTo(
          ev.replyToken,
          `บันทึกการรับประทานแล้ว:\n${takenList.map((t, i) => `${i + 1}. ${t}`).join('\n')}`,
        );
      }
      return;
    }

    // ❷ คลังยา → บันทึกใบล่าสุดเข้าคลัง (เผื่อยังอยากคงปุ่มเดิมไว้)
    if (text === 'คลังยา') {
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

      await this.prisma.medicationInventory.upsert({
        where: {
          patientId_prescriptionId: {
            patientId: patient.id,
            prescriptionId: patient.recentActivatedPrescriptionId,
          },
        },
        create: {
          patientId: patient.id,
          prescriptionId: patient.recentActivatedPrescriptionId,
          isActive: true,
        },
        update: { isActive: true },
      });

      const rx = await this.prisma.prescription.findUnique({
        where: { id: patient.recentActivatedPrescriptionId },
        select: { drugName: true },
      });

      await this.replyTo(
        ev.replyToken,
        `บันทึกเข้าคลังยาแล้ว: ${rx?.drugName}`,
      );
      return;
    }
  }

  /** รองรับ postback เผื่อคุณไปสร้าง rich menu ผ่าน Messaging API ภายหลัง */
  private async onPostback(ev: any) {
    const data = String(ev.postback.data || '');
    if (data === 'inventory_open') {
      await this.replyTo(ev.replyToken, 'กำลังพัฒนาเมนูเลือกหลายใบยา 😉');
    }
  }

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

/* ===== Helpers (เวลา/โซน/ข้อความ) ===== */
function formatYMDInTz(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(date);
}
function formatHHMMInTz(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  return fmt.format(date);
}
function hhmmToMinutes(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
function ymdToMidnightUTC(ymd: string) {
  return new Date(`${ymd}T00:00:00.000Z`);
}
function periodToThai(p: string) {
  return p === 'MORNING'
    ? 'เช้า'
    : p === 'NOON'
      ? 'กลางวัน'
      : p === 'EVENING'
        ? 'เย็น'
        : p === 'BEDTIME'
          ? 'ก่อนนอน'
          : 'อื่นๆ';
}
