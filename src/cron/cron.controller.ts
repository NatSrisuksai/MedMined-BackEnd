import { Controller, Get, Logger, Query, Req } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

let running = false;
let startedAt = 0;
const MAX_RUN_MS = 55_000;

const REMIND_EVERY_MIN = 30; // เตือนซ้ำทุก 30 นาที
// const DYNAMIC = process.env.CRON_DYNAMIC_WINDOW === '1';
const DYNAMIC = true;
const VERBOSE = (process.env.CRON_VERBOSE || '1') !== '0';

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
      return {
        ok: true,
        ...result,
        at: new Date().toISOString(),
        dynamic: DYNAMIC,
      };
    } catch (err: any) {
      this.logger.error('Cron tick failed', err?.stack || err);
      return { ok: false, error: String(err?.message || err) };
    } finally {
      running = false;
      startedAt = 0;
    }
  }

  private async processTick() {
    if (VERBOSE) this.logger.log('processTick: fetching patients…');

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

    if (VERBOSE) this.logger.log(`processTick: patients=${patients.length}`);

    let users = 0,
      items = 0;

    for (const p of patients) {
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
              issueDate: true,
              createdAt: true,
              quantityTotal: true,
              schedules: {
                where: { isActive: true },
                select: { period: true, hhmm: true, pills: true },
                orderBy: { hhmm: 'asc' },
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
        period: string; // ✅ ใช้สำหรับเลือกรูป
      }[] = [];

      for (const inv of invs) {
        const rx = inv.prescription;
        if (!rx || rx.schedules.length === 0) continue;

        const tz = rx.timezone || 'Asia/Bangkok';
        const { ymd, minutes: nowMin } = nowInTz(tz);

        const effStart = rx.startDate ?? rx.issueDate ?? rx.createdAt;
        const startOk = formatYMDInTz(effStart, tz) <= ymd;
        const endOk = !rx.endDate || ymd <= formatYMDInTz(rx.endDate, tz);
        if (!startOk || !endOk) continue;

        // กินครบคอร์สแล้ว → ปิดคลัง + แจ้งจบคอร์ส แล้วข้าม
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
                    patientId: p.id,
                    prescriptionId: rx.id,
                  },
                },
                data: { isActive: false },
              });
            } catch {}
            try {
              await pushText(
                p.lineUserId!,
                `🎉 คอร์สยา "${rx.drugName}" ครบแล้ว ระบบหยุดแจ้งเตือนให้แล้วค่ะ/ครับ`,
              );
            } catch {}
            continue;
          }
        }

        if (DYNAMIC) {
          const sorted = rx.schedules
            .slice()
            .sort((a, b) => a.hhmm.localeCompare(b.hhmm));
          for (let i = 0; i < sorted.length; i++) {
            const s = sorted[i];
            const start = hhmmToMinutes(s.hhmm);
            const end =
              i + 1 < sorted.length
                ? hhmmToMinutes(sorted[i + 1].hhmm)
                : 24 * 60;
            if (!(nowMin >= start && nowMin < end)) continue;

            const slotDate = ymdToMidnightUTC(ymd);

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
            if (taken) break;

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
            if (!shouldRemind) break;

            const label = `${periodToThai(s.period)} ${s.hhmm} — ${rx.drugName} ${s.pills} เม็ด`;
            dueSlots.push({
              rxId: rx.id,
              rxName: rx.drugName,
              tz,
              label,
              slotHhmm: s.hhmm,
              pills: s.pills,
              slotDateISO: slotDate.toISOString(),
              period: s.period, // ✅
            });
            break;
          }
        } else {
          for (const s of rx.schedules) {
            const win = PERIOD_WINDOWS[s.period];
            if (!win) continue;
            if (!(nowMin >= win.start && nowMin < win.end)) continue;

            const slotDate = ymdToMidnightUTC(ymd);

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
              tz,
              label,
              slotHhmm: s.hhmm,
              pills: s.pills,
              slotDateISO: slotDate.toISOString(),
              period: s.period, // ✅
            });
          }
        }
      }

      if (dueSlots.length === 0) continue;

      const name =
        p.fullName || [p.firstName, p.lastName].filter(Boolean).join(' ');
      const msg = `⏰ ถึงเวลาใช้ยาแล้ว
${name ? `ผู้ป่วย: ${name}\n` : ''}${dueSlots.map((d, i) => `${i + 1}. ${d.label}`).join('\n')}
(พิมพ์ "รับประทานยาแล้ว" เพื่อหยุดเตือนช่วงนี้)`;

      // ✅ เตรียมรูปตามช่วง (unique) แล้ว push multi-message
      const uniquePeriods = Array.from(
        new Set(dueSlots.map((d) => d.period)),
      ).slice(0, 4);
      const imageMessages = uniquePeriods
        .map((p) => periodImageUrl(p))
        .filter((u): u is string => !!u)
        .map((u) => ({
          type: 'image',
          originalContentUrl: u,
          previewImageUrl: u,
        }));

      const messages = [...imageMessages, { type: 'text', text: msg }];

      try {
        if (messages.length > 1) {
          await pushMulti(p.lineUserId!, messages);
        } else {
          await pushText(p.lineUserId!, msg);
        }
      } catch (e: any) {
        this.logger.error(
          `LINE push error to ${p.lineUserId}: ${e?.message || e}`,
        );
        continue;
      }

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

// ===== Image URL helpers & pushers =====
function periodImageUrl(period: string): string | null {
  const base = (
    process.env.PUBLIC_BASE_URL ||
    process.env.BASE_URL ||
    ''
  ).replace(/\/+$/, '');
  if (!base) return null;
  const file =
    period === 'MORNING'
      ? 'morning.jpg'
      : period === 'NOON'
        ? 'noon.jpg'
        : period === 'EVENING'
          ? 'evening.jpg'
          : period === 'BEDTIME'
            ? 'bedtime.jpg'
            : null;
  return file ? `${base}/assets/${file}` : null;
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

async function pushMulti(to: string, messages: any[]) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN!;
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to, messages }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LINE push ${res.status}: ${body}`);
  }
}
