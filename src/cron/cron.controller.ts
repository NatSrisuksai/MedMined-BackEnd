import { Controller, Get, Logger, Query, Req } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

let running = false;
let startedAt = 0;
const MAX_RUN_MS = 55_000;

const VERBOSE = (process.env.CRON_VERBOSE || '1') !== '0';
const REMIND_DEFAULT_MIN = Number(process.env.CRON_REMIND_MIN ?? 30);

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

      const dueSlots: {
        rxId: string;
        rxName: string;
        tz: string;
        label: string;
        slotHhmm: string;
        pills: number;
        slotDateISO: string;
        period: string;
      }[] = [];

      for (const inv of invs) {
        const rx = inv.prescription;
        if (!rx || rx.schedules.length === 0) continue;

        // ตรวจช่วงเริ่ม/สิ้นสุดคอร์ส
        const tz = rx.timezone || 'Asia/Bangkok';
        const { ymd, minutes: nowMin } = nowInTz(tz);
        const effStart = rx.startDate ?? rx.issueDate ?? rx.createdAt;
        const startOk = formatYMDInTz(effStart, tz) <= ymd;
        const endOk = !rx.endDate || ymd <= formatYMDInTz(rx.endDate, tz);
        if (!startOk || !endOk) continue;

        // ถ้ากินครบแล้ว → ปิด inventory + แจ้งจบคอร์สครั้งเดียว
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

        // === เลือก slot ปัจจุบันแบบ dynamic ตามกติกาใหม่ ===
        const sorted = rx.schedules
          .filter((s) => s.isActive)
          .slice()
          .sort((a, b) => a.hhmm.localeCompare(b.hhmm));
        if (sorted.length === 0) continue;

        for (let i = 0; i < sorted.length; i++) {
          const s = sorted[i];
          const nextStart = i + 1 < sorted.length ? sorted[i + 1].hhmm : null;
          const { winStart, winEnd, remindEveryMin } = computeWindowForSlot(
            s.hhmm,
            s.period,
            nextStart,
          );

          if (!(nowMin >= winStart && nowMin < winEnd)) continue;

          const slotDate = ymdToMidnightUTC(ymd);

          // ถ้ากิน slot นี้แล้วในวันนี้ → ไม่ต้องเตือน
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

          // เตือนซ้ำตาม cadence ในหน้าต่าง
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
          const cadence = remindEveryMin ?? REMIND_DEFAULT_MIN;
          const shouldRemind =
            !lastNotif ||
            Date.now() - new Date(lastNotif.sentAt).getTime() >=
              cadence * 60_000;
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
            period: s.period,
          });

          break; // เจอ slot ปัจจุบันของใบยานี้แล้ว
        }
      }

      if (dueSlots.length === 0) continue;

      const name =
        p.fullName || [p.firstName, p.lastName].filter(Boolean).join(' ');
      const msg = `⏰ ถึงเวลาใช้ยาแล้ว
${name ? `ผู้ป่วย: ${name}\n` : ''}${dueSlots.map((d, i) => `${i + 1}. ${d.label}`).join('\n')}
(พิมพ์ "รับประทานยาแล้ว" เพื่อหยุดเตือนช่วงนี้)`;

      try {
        await pushText(p.lineUserId!, msg);
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

// # กติกา “หน้าต่างเตือน” ตาม 1–5
function computeWindowForSlot(
  currentHHMM: string,
  currentPeriod: string,
  nextStartHHMM: string | null,
) {
  const start = hhmmToMinutes(currentHHMM);
  const hardStop = nextStartHHMM ? hhmmToMinutes(nextStartHHMM) : 24 * 60;

  // 1) ก่อนอาหาร → 1 ชั่วโมงหลังเวลา slot (เตือนทุก 30 นาที)
  if (
    currentPeriod === 'BEFORE_BREAKFAST' ||
    currentPeriod === 'BEFORE_LUNCH' ||
    currentPeriod === 'BEFORE_DINNER'
  ) {
    const end1h = start + 60;
    return {
      winStart: start,
      winEnd: Math.min(end1h, hardStop),
      remindEveryMin: 30,
    };
  }

  // 5) ก่อนนอน → เตือนทุก 30 นาที จนถึงเที่ยงคืน
  if (currentPeriod === 'BEFORE_BED') {
    return { winStart: start, winEnd: 24 * 60, remindEveryMin: 30 };
  }

  // 4) หลังอาหาร/อื่น ๆ → จนถึง slot ถัดไป (เตือนทุก 30 นาที)
  return { winStart: start, winEnd: hardStop, remindEveryMin: 30 };
}

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
    day: 'numeric',
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

/* ===== LINE push (simple text) ===== */
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
