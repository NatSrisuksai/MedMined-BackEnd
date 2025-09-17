import { Controller, Get, Logger, Query, Req } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

let running = false;
let startedAt = 0;
const MAX_RUN_MS = 55_000;
const REMIND_EVERY_MIN = 30; // เตือนซ้ำทุก 30 นาที
const VERBOSE = (process.env.CRON_VERBOSE || '1') !== '0';

@Controller('api/cron')
export class CronController {
  private readonly logger = new Logger(CronController.name);
  constructor(private readonly prisma: PrismaService) {}

  @Get('tick')
  async tick(@Req() req: any, @Query('secret') secretQ?: string) {
    const secretH = req.headers['x-cron-secret'] as string | undefined;
    const okSecret =
      (secretQ && secretQ === process.env.CRON_SECRET) ||
      (secretH && secretH === process.env.CRON_SECRET);
    if (!okSecret) return { ok: false, reason: 'forbidden' };

    const nowMs = Date.now();
    if (running && nowMs - startedAt < MAX_RUN_MS) {
      if (VERBOSE) this.logger.warn('Skip: cron is already running');
      return { ok: false, reason: 'cron-is-running' };
    }
    if (running && nowMs - startedAt >= MAX_RUN_MS) {
      running = false;
      if (VERBOSE) this.logger.warn('Reset stale cron flag');
    }
    running = true;
    startedAt = nowMs;

    try {
      const result = await this.processTick();
      if (VERBOSE)
        this.logger.log(`DONE users=${result.users} items=${result.items}`);
      return { ok: true, ...result, at: new Date().toISOString() };
    } catch (err: any) {
      this.logger.error('Cron tick failed', err?.stack || err);
      return { ok: false, error: String(err?.message || err) };
    } finally {
      running = false;
      startedAt = 0;
    }
  }

  private async processTick() {
    // 1) ผู้ใช้ที่เป็นเพื่อน OA (มี lineUserId)
    const patients = await this.prisma.patient.findMany({
      where: { lineUserId: { not: null } },
      select: {
        id: true,
        fullName: true,
        firstName: true,
        lastName: true,
        lineUserId: true,
      },
    });

    let users = 0,
      items = 0;

    // 2) เดินทีละคน
    for (const p of patients) {
      // คลังยาที่เปิดแจ้งเตือน
      const invs = await this.prisma.medicationInventory.findMany({
        where: { patientId: p.id, isActive: true },
        select: {
          prescription: {
            select: {
              id: true,
              drugName: true,
              timezone: true,
              startDate: true,
              endDate: true,
              quantityTotal: true,
              schedules: {
                where: { isActive: true },
                select: { period: true, hhmm: true, pills: true },
              },
            },
          },
        },
      });

      const dueSlots: {
        rxId: string;
        rxName: string;
        tz: string;
        label: string;
        slotHhmm: string;
        pills: number;
        slotDateISO: string;
      }[] = [];

      for (const inv of invs) {
        const rx = inv.prescription;
        if (!rx) continue;

        const rxTz = rx.timezone || 'Asia/Bangkok';
        const { ymd, minutes } = nowInTz(rxTz);

        // อยู่ในช่วงวันของคอร์ส
        const startOk = formatYMDInTz(rx.startDate, rxTz) <= ymd;
        const endOk = !rx.endDate || ymd <= formatYMDInTz(rx.endDate, rxTz);
        if (!startOk || !endOk) continue;

        // (ออปชัน) ถ้าทานครบจำนวนทั้งหมดแล้ว ให้ข้าม
        if (typeof rx.quantityTotal === 'number') {
          const sumTaken = await this.prisma.doseIntake.aggregate({
            where: { prescriptionId: rx.id },
            _sum: { pills: true },
          });
          if ((sumTaken._sum.pills || 0) >= rx.quantityTotal) continue;
        }

        for (const s of rx.schedules) {
          const schedMin = hhmmToMinutes(s.hhmm);
          if (minutes < schedMin) continue; // ยังไม่ถึงเวลา

          const slotDate = ymdToMidnightUTC(ymd);

          // ถ้ากินแล้วใน slot นี้วันนี้ → ไม่เตือน
          const taken = await this.prisma.doseIntake.findUnique({
            where: {
              patientId_prescriptionId_slotDate_hhmm: {
                patientId: p.id,
                prescriptionId: rx.id,
                slotDate,
                hhmm: s.hhmm,
              },
            },
            select: { id: true },
          });
          if (taken) continue;

          // เตือนซ้ำทุก 30 นาที
          const lastNotif = await this.prisma.notificationLog.findFirst({
            where: {
              patientId: p.id,
              prescriptionId: rx.id,
              slotDate,
              hhmm: s.hhmm,
            },
            orderBy: { sentAt: 'desc' },
            select: { sentAt: true },
          });
          const shouldRemind =
            !lastNotif ||
            Date.now() - new Date(lastNotif.sentAt).getTime() >=
              REMIND_EVERY_MIN * 60_000;
          if (!shouldRemind) continue;

          const label = `${periodToThai(s.period)} ${s.hhmm} — ${rx.drugName} ${s.pills} เม็ด`;
          dueSlots.push({
            rxId: rx.id,
            rxName: rx.drugName,
            tz: rxTz,
            label,
            slotHhmm: s.hhmm,
            pills: s.pills,
            slotDateISO: slotDate.toISOString(),
          });
        }
      }

      if (dueSlots.length === 0) continue;

      const name =
        p.fullName || [p.firstName, p.lastName].filter(Boolean).join(' ');
      const msg = `⏰ ถึงเวลาใช้ยาแล้ว
${name ? `ผู้ป่วย: ${name}\n` : ''}${dueSlots.map((d, i) => `${i + 1}. ${d.label}`).join('\n')}
(ตอบ "รับประทานยาแล้ว" เพื่อหยุดเตือนมื้อนี้)`;

      try {
        await pushText(p.lineUserId!, msg);
      } catch (e: any) {
        this.logger.error(
          `LINE push error to ${p.lineUserId}: ${e?.message || e}`,
        );
        continue;
      }

      // บันทึก NotificationLog ของแต่ละ slot
      await this.prisma.$transaction(
        dueSlots.map((d) =>
          this.prisma.notificationLog.create({
            data: {
              patientId: p.id,
              prescriptionId: d.rxId,
              hhmm: d.slotHhmm,
              slotDate: new Date(d.slotDateISO),
            },
          }),
        ),
      );

      users += 1;
      items += dueSlots.length;
    }

    return { users, items };
  }
}

/* ===== Helpers ===== */
function nowInTz(tz: string) {
  const ymd = formatYMDInTz(new Date(), tz);
  const hhmm = formatHHMMInTz(new Date(), tz);
  const minutes = hhmmToMinutes(hhmm);
  return { ymd, hhmm, minutes };
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
async function pushText(to: string, text: string) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN!;
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LINE push ${res.status}: ${body}`);
  }
}
