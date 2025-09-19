import { Controller, Post, Req, Res, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';

const PERIOD_WINDOWS: Record<string, { start: number; end: number }> = {
  MORNING: { start: hm('08:00'), end: hm('12:00') },
  NOON: { start: hm('12:00'), end: hm('18:00') },
  EVENING: { start: hm('18:00'), end: hm('22:00') },
  BEDTIME: { start: hm('22:00'), end: hm('24:00') },
  CUSTOM: { start: 0, end: 0 },
};
function hm(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

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
        }
      } catch (err) {
        this.logger.error('Webhook event error', err as any);
      }
    }

    return res.status(200).send('OK');
  }

  private async onText(ev: any) {
    const lineUserId = ev?.source?.userId;
    if (!lineUserId) return;
    const text: string = String(ev.message?.text || '').trim();

    if (text === 'รับประทานยาแล้ว') {
      const patient = await this.prisma.patient.findFirst({
        where: { lineUserId },
        select: { id: true, fullName: true },
      });
      if (!patient) {
        await this.replyTo(
          ev.replyToken,
          'ยังไม่พบบัญชีผู้ใช้ โปรดสแกน QR ใบยาก่อน',
        );
        return;
      }

      const invs = await this.prisma.medicationInventory.findMany({
        where: { patientId: patient.id, isActive: true },
        select: {
          prescription: {
            select: {
              id: true,
              drugName: true,
              timezone: true,
              quantityTotal: true, // ✅ ต้องใช้เพื่อเช็กครบคอร์ส
              schedules: {
                where: { isActive: true },
                select: { period: true, hhmm: true, pills: true },
              },
            },
          },
        },
      });

      const takenList: string[] = [];
      const completionLines: string[] = []; // ✅ เก็บบรรทัดแจ้งจบคอร์ส (อาจมีหลายใบ)

      for (const inv of invs) {
        const rx = inv.prescription;
        if (!rx || rx.schedules.length === 0) continue;

        const tz = rx.timezone || 'Asia/Bangkok';
        const ymd = formatYMDInTz(new Date(), tz);
        const nowMin = hhmmToMinutes(formatHHMMInTz(new Date(), tz));

        // หาช่วง "ปัจจุบัน" ตาม fixed windows
        const current = rx.schedules.find((s) => {
          const win = PERIOD_WINDOWS[s.period];
          return win && nowMin >= win.start && nowMin < win.end;
        });
        if (!current) continue;

        const slotDate = ymdToMidnightUTC(ymd);

        // กันบันทึกซ้ำ
        const exists = await this.prisma.doseIntake.findUnique({
          where: {
            patientId_prescriptionId_slotDate_hhmm: {
              patientId: patient.id,
              prescriptionId: rx.id,
              slotDate,
              hhmm: current.hhmm,
            },
          },
          select: { id: true },
        });
        if (exists) continue;

        // บันทึกการทานเฉพาะช่วงนี้
        await this.prisma.doseIntake.create({
          data: {
            patientId: patient.id,
            prescriptionId: rx.id,
            slotDate,
            hhmm: current.hhmm,
            pills: current.pills,
          },
        });

        takenList.push(
          `${rx.drugName} — ${periodToThai(current.period)} ${current.hhmm} (${current.pills} เม็ด)`,
        );

        // ✅ เช็กครบคอร์ส "ทันที" หลังบันทึก แล้วปิดคลัง + เติมบรรทัดแจ้งเตือน
        if (typeof rx.quantityTotal === 'number') {
          const sumTaken = await this.prisma.doseIntake.aggregate({
            where: { prescriptionId: rx.id },
            _sum: { pills: true },
          });
          const consumed = sumTaken._sum.pills || 0;
          if (consumed >= rx.quantityTotal) {
            // ปิดคลังยา (กัน cron ดึงมาอีก)
            try {
              await this.prisma.medicationInventory.update({
                where: {
                  patientId_prescriptionId: {
                    patientId: patient.id,
                    prescriptionId: rx.id,
                  },
                },
                data: { isActive: false },
              });
            } catch (e: any) {
              this.logger.warn(
                `inventory deactivate failed p=${patient.id} rx=${rx.id}: ${e?.message || e}`,
              );
            }
            // เติมบรรทัดแจ้งจบคอร์สใน "ข้อความตอบกลับเดียวกัน"
            completionLines.push(
              `🎉 คอร์สยา "${rx.drugName}" ครบแล้ว ระบบหยุดแจ้งเตือนให้แล้วค่ะ/ครับ`,
            );
          }
        }
      }

      if (takenList.length === 0) {
        await this.replyTo(
          ev.replyToken,
          'ยังไม่พบช่วงเวลาปัจจุบัน หรือบันทึกไปแล้ว',
        );
      } else {
        const msg =
          `บันทึกการรับประทานแล้ว:\n` +
          takenList.map((t, i) => `${i + 1}. ${t}`).join('\n') +
          (completionLines.length ? `\n\n${completionLines.join('\n')}` : '');
        await this.replyTo(ev.replyToken, msg);
      }
      return;
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
