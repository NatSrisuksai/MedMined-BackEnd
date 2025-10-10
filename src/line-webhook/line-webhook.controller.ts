import { Controller, Post, Req, Res, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';

@Controller('webhook/line')
export class LineWebhookController {
  private readonly logger = new Logger(LineWebhookController.name);
  constructor(private readonly prisma: PrismaService) {}

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

    const body = JSON.parse(raw.toString('utf8'));
    const events = body.events || [];

    for (const ev of events) {
      try {
        if (ev.type === 'message' && ev.message?.type === 'text') {
          await this.onText(ev);
        } else if (ev.type === 'postback' && ev.postback?.data) {
          await this.replyTo(ev.replyToken, 'กำลังพัฒนาเมนู 😉');
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

    // =========================
    // 1) เมนู "ข้อมูลผู้ใช้"
    // =========================
    if (text === 'ข้อมูลผู้ใช้') {
      const patient = await this.prisma.patient.findFirst({
        where: { lineUserId },
        select: { id: true, fullName: true, age: true, hn: true },
      });
      if (!patient) {
        await this.replyTo(
          ev.replyToken,
          'ยังไม่พบบัญชีผู้ใช้ โปรดสแกน QR ใบยาก่อน',
        );
        return;
      }

      // ดึงยาที่อยู่ใน "คลังยา" (เปิดใช้งานอยู่)
      const invs = await this.prisma.medicationInventory.findMany({
        where: { patientId: patient.id, isActive: true },
        select: {
          prescription: {
            select: {
              id: true,
              drugName: true,
              quantityTotal: true,
              schedules: {
                where: { isActive: true },
                select: { period: true, hhmm: true, pills: true },
                orderBy: { hhmm: 'asc' },
              },
            },
          },
        },
        orderBy: { prescriptionId: 'asc' },
      });

      const lines: string[] = [];
      let idx = 1;

      for (const inv of invs) {
        const rx = inv.prescription;
        if (!rx) continue;

        const schedulesText = rx.schedules.length
          ? rx.schedules
              .map(
                (s) => `${periodToThai(s.period)} ${s.hhmm} (${s.pills} เม็ด)`,
              )
              .join(', ')
          : '-';

        // รวมยอดที่กินไปแล้ว เพื่อนับ "ยังเหลือ"
        let remainingText = '-';
        if (typeof rx.quantityTotal === 'number') {
          const sum = await this.prisma.doseIntake.aggregate({
            where: { prescriptionId: rx.id },
            _sum: { pills: true },
          });
          const taken = sum._sum.pills || 0;
          const remaining = Math.max(0, rx.quantityTotal - taken);
          remainingText = `${remaining}`;
        }

        lines.push(
          `${idx}. ${rx.drugName} จำนวน ${rx.quantityTotal ?? '-'}\n` +
            `ช่วงเวลาที่ต้องกิน: ${schedulesText}\n` +
            `ยังเหลือยาที่ต้องกิน: ${remainingText}`,
        );
        idx++;
      }

      const header =
        `ชื่อผู้ป่วย: ${patient.fullName || '-'}  อายุ: ${patient.age ?? '-'}\n` +
        `HN: ${patient.hn ?? '-'}`;
      const body = lines.length
        ? `รายชื่อยาทั้งหมด:\n${lines.join('\n')}`
        : 'ยังไม่มีใบยาที่เปิดแจ้งเตือน';

      await this.replyTo(ev.replyToken, `${header}\n${body}`);
      return;
    }

    // =========================
    // 2) เมนู "รับประทานยาแล้ว"
    // =========================
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
              quantityTotal: true,
              schedules: {
                where: { isActive: true },
                select: {
                  period: true,
                  hhmm: true,
                  pills: true,
                  isActive: true,
                }, // <-- add isActive
                orderBy: { hhmm: 'asc' },
              },
            },
          },
        },
      });

      const takenList: string[] = [];
      const finishedNow: string[] = [];

      for (const inv of invs) {
        const rx = inv.prescription;
        if (!rx || rx.schedules.length === 0) continue;

        const tz = rx.timezone || 'Asia/Bangkok';
        const ymd = formatYMDInTz(new Date(), tz);
        const nowMin = hhmmToMinutes(formatHHMMInTz(new Date(), tz));

        const sorted = rx.schedules
          .filter((s) => s.isActive)
          .slice()
          .sort((a, b) => a.hhmm.localeCompare(b.hhmm));
        let current: (typeof sorted)[number] | null = null;

        for (let i = 0; i < sorted.length; i++) {
          const s = sorted[i];
          const nextStart = i + 1 < sorted.length ? sorted[i + 1].hhmm : null;
          const { winStart, winEnd } = computeWindowForSlot(
            s.hhmm,
            s.period,
            nextStart,
          );
          if (nowMin >= winStart && nowMin < winEnd) {
            current = s;
            break;
          }
        }
        if (!current) continue; // อยู่นอกหน้าต่างของมื้อใด ๆ

        const slotDate = ymdToMidnightUTC(ymd);
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

        // เช็คครบคอร์สทันที
        if (typeof rx.quantityTotal === 'number') {
          const sumTaken = await this.prisma.doseIntake.aggregate({
            where: { prescriptionId: rx.id },
            _sum: { pills: true },
          });
          const consumed = sumTaken._sum.pills || 0;
          if (consumed >= rx.quantityTotal) {
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
            } catch {}
            finishedNow.push(
              `🎉 คอร์สยา "${rx.drugName}" ครบแล้ว ระบบหยุดแจ้งเตือนให้แล้วค่ะ/ครับ`,
            );
          }
        }
      }

      if (takenList.length === 0) {
        await this.replyTo(
          ev.replyToken,
          'ยังไม่พบมื้อที่ถึงเวลาในตอนนี้ หรือบันทึกไปแล้ว',
        );
      } else {
        const text = `บันทึกการรับประทานแล้ว:
${takenList.map((t, i) => `${i + 1}. ${t}`).join('\n')}
${finishedNow.length ? '\n' + finishedNow.join('\n') : ''}`;
        await this.replyTo(ev.replyToken, text);
      }
      return;
    }
  }

  private async replyTo(replyToken: string, text: string | any) {
    const token = process.env.LINE_CHANNEL_ACCESS_TOKEN!;
    const messages =
      typeof text === 'string' ? [{ type: 'text', text }] : [text];
    await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ replyToken, messages }),
    });
  }
}

/* ===== Helpers (ให้สอดคล้องกับ cron) ===== */

function computeWindowForSlot(
  currentHHMM: string,
  currentPeriod: string,
  nextStartHHMM: string | null,
) {
  const start = hhmmToMinutes(currentHHMM);
  const hardStop = nextStartHHMM ? hhmmToMinutes(nextStartHHMM) : 24 * 60;

  // ก่อนอาหาร → 1 ชั่วโมงหลังเวลา slot
  if (
    currentPeriod === 'BEFORE_BREAKFAST' ||
    currentPeriod === 'BEFORE_LUNCH' ||
    currentPeriod === 'BEFORE_DINNER'
  ) {
    const end1h = start + 60;
    return { winStart: start, winEnd: Math.min(end1h, hardStop) };
  }

  // ก่อนนอน → ถึงเที่ยงคืน
  if (currentPeriod === 'BEFORE_BED') {
    return { winStart: start, winEnd: 24 * 60 };
  }

  // หลังอาหาร/อื่น ๆ → ถึง slot ถัดไป
  return { winStart: start, winEnd: hardStop };
}

function periodToThai(p: string) {
  return p === 'BEFORE_BREAKFAST'
    ? 'ก่อนอาหารเช้า'
    : p === 'AFTER_BREAKFAST'
      ? 'หลังอาหารเช้า'
      : p === 'BEFORE_LUNCH'
        ? 'ก่อนอาหารเที่ยง'
        : p === 'AFTER_LUNCH'
          ? 'หลังอาหารเที่ยง'
          : p === 'BEFORE_DINNER'
            ? 'ก่อนอาหารเย็น'
            : p === 'AFTER_DINNER'
              ? 'หลังอาหารเย็น'
              : p === 'BEFORE_BED'
                ? 'ก่อนนอน'
                : 'อื่นๆ';
}
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
