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
      } catch (err) {
        this.logger.error('Webhook event error', err as any);
      }
    }

    return res.status(200).send('OK');
  }

  /** รับเฉพาะข้อความจากผู้ใช้ */
  private async onText(ev: any) {
    const lineUserId = ev?.source?.userId;
    if (!lineUserId) return;
    const text: string = String(ev.message?.text || '').trim();

    // ✅ รับประทานยาแล้ว → บันทึกเฉพาะ "ช่วงเวลาปัจจุบัน" ของแต่ละใบยา
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

      // คลังยาที่เปิดอยู่
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
                orderBy: { hhmm: 'asc' },
              },
            },
          },
        },
      });

      const takenList: string[] = [];

      for (const inv of invs) {
        const rx = inv.prescription;
        if (!rx || rx.schedules.length === 0) continue;

        const tz = rx.timezone || 'Asia/Bangkok';
        const ymd = formatYMDInTz(new Date(), tz);
        const nowMin = hhmmToMinutes(formatHHMMInTz(new Date(), tz));

        const sorted = rx.schedules
          .slice()
          .sort((a, b) => a.hhmm.localeCompare(b.hhmm));

        // หาช่วงเวลาปัจจุบันเพียง 1 ช่วง: start <= now < nextStart
        let current = null as null | {
          hhmm: string;
          pills: number;
          period: string;
        };
        for (let i = 0; i < sorted.length; i++) {
          const s = sorted[i];
          const startMin = hhmmToMinutes(s.hhmm);
          const endMin =
            i + 1 < sorted.length ? hhmmToMinutes(sorted[i + 1].hhmm) : 24 * 60;
          if (nowMin >= startMin && nowMin < endMin) {
            current = { hhmm: s.hhmm, pills: s.pills, period: s.period };
            break;
          }
        }
        if (!current) continue; // ตอนนี้ไม่ได้อยู่ในช่วงไหน → ข้ามใบยานี้

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
      }

      if (takenList.length === 0) {
        await this.replyTo(
          ev.replyToken,
          'ยังไม่พบช่วงเวลาปัจจุบัน หรือบันทึกไปแล้ว',
        );
      } else {
        await this.replyTo(
          ev.replyToken,
          `บันทึกการรับประทานแล้ว:\n${takenList.map((t, i) => `${i + 1}. ${t}`).join('\n')}`,
        );
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
