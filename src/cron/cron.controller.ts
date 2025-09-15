import { Controller, Get, Logger, Query, Req } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

// ====== Guard กันงานซ้อน (in-memory) ======
let running = false;
let startedAt = 0; // ms
const MAX_RUN_MS = 55_000; // ป้องกันค้างนานเกินไป
const VERBOSE = (process.env.CRON_VERBOSE || '1') !== '0';

@Controller('api/cron')
export class CronController {
  private readonly logger = new Logger(CronController.name);

  constructor(private readonly prisma: PrismaService) {}

  // ✔️ endpoint เทสต์ง่ายๆ
  @Get('ping')
  ping() {
    if (VERBOSE) {
      this.logger.log('PING');
      console.log('[CRON] PING');
    }
    return { ok: true, pong: new Date().toISOString() };
  }

  @Get('tick')
  async tick(@Req() req: any, @Query('secret') secretQ?: string) {
    const ua = req.headers['user-agent'];
    const ip =
      req.headers['x-forwarded-for'] ||
      req.socket?.remoteAddress ||
      req.ip ||
      'unknown';

    if (VERBOSE) {
      this.logger.log(`TICK hit from ${ip} ua=${ua} q=${secretQ ?? ''}`);
      console.log(`[CRON] TICK hit from ${ip} ua=${ua} q=${secretQ ?? ''}`);
    }

    // --- check secret (query หรือ header) ---
    const secretH = req.headers['x-cron-secret'] as string | undefined;
    const okSecret =
      (secretQ && secretQ === process.env.CRON_SECRET) ||
      (secretH && secretH === process.env.CRON_SECRET);

    if (!okSecret) {
      if (VERBOSE) {
        this.logger.warn('Forbidden: bad/missing secret');
        console.warn('[CRON] Forbidden: bad/missing secret');
      }
      return { ok: false, reason: 'forbidden' };
    }

    // --- guard กันงานซ้อน ---
    const nowMs = Date.now();
    if (running && nowMs - startedAt < MAX_RUN_MS) {
      if (VERBOSE) {
        this.logger.warn('Skip: cron is already running');
        console.warn('[CRON] Skip: cron is already running');
      }
      return { ok: false, reason: 'cron-is-running' };
    }
    if (running && nowMs - startedAt >= MAX_RUN_MS) {
      if (VERBOSE) {
        this.logger.warn('Reset stale cron flag');
        console.warn('[CRON] Reset stale cron flag');
      }
      running = false;
    }

    running = true;
    startedAt = nowMs;

    try {
      const result = await this.processTick();
      if (VERBOSE) {
        this.logger.log(`DONE users=${result.users} items=${result.items}`);
        console.log(`[CRON] DONE users=${result.users} items=${result.items}`);
      }
      return { ok: true, ...result, at: new Date().toISOString() };
    } catch (err: any) {
      this.logger.error('Cron tick failed', err?.stack || err);
      console.error('[CRON] ERROR', err?.message || err);
      return { ok: false, error: String(err?.message || err) };
    } finally {
      running = false;
      startedAt = 0;
    }
  }

  // ====== งานหลักของ cron (sequential) ======
  private async processTick() {
    if (VERBOSE) {
      this.logger.log('processTick: fetching patients…');
      console.log('[CRON] processTick: fetching patients…');
    }

    // 1) ผู้ใช้ที่มี lineUserId + คลังยา isActive
    const patients = await this.prisma.patient.findMany({
      where: {
        lineUserId: { not: null },
        inventories: { some: { isActive: true } },
      },
      select: {
        id: true,
        fullName: true,
        lineUserId: true,
        inventories: {
          where: { isActive: true },
          select: {
            prescription: {
              select: {
                id: true,
                drugName: true,
                strength: true,
                instruction: true,
                timesCsv: true,
                timezone: true,
                startDate: true,
                endDate: true,
              },
            },
          },
        },
      },
    });

    if (VERBOSE) {
      this.logger.log(`processTick: patients=${patients.length}`);
      console.log(`[CRON] processTick: patients=${patients.length}`);
    }

    let totalUsersPushed = 0;
    let totalItemsDue = 0;

    // 2) เดินทีละคน
    for (const p of patients) {
      const lineUserId = p.lineUserId!;
      const dueList: { rxId: string; label: string; hhmm: string }[] = [];

      // ตรวจแต่ละ prescription ที่ถูกเปิดในคลัง
      for (const inv of p.inventories) {
        const rx = inv.prescription;
        if (!rx) continue;

        const tz = rx.timezone || 'Asia/Bangkok';

        const todayYmd = formatYMDInTz(new Date(), tz);
        const startYmd = formatYMDInTz(new Date(rx.startDate), tz);
        const endYmd = rx.endDate
          ? formatYMDInTz(new Date(rx.endDate), tz)
          : null;

        const startOk = startYmd <= todayYmd;
        const endOk = !endYmd || todayYmd <= endYmd;
        if (!startOk || !endOk) continue;

        const hhmmNow = formatHHMMInTz(new Date(), tz);
        const times = (rx.timesCsv || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);

        if (!times.includes(hhmmNow)) continue;

        // กันยิงซ้ำภายใน 60 วินาที
        const recent = await this.prisma.notificationLog.findFirst({
          where: {
            patientId: p.id,
            prescriptionId: rx.id,
            hhmm: hhmmNow,
            sentAt: { gte: new Date(Date.now() - 60_000) },
          },
          select: { id: true },
        });
        if (recent) continue;

        const label = `${rx.drugName}${rx.strength ? ` (${rx.strength})` : ''} — ${rx.instruction || '-'}`;
        dueList.push({ rxId: rx.id, label, hhmm: hhmmNow });
      }

      if (dueList.length === 0) continue;

      const message =
        `ถึงเวลาใช้ยาแล้ว\n` +
        (p.fullName ? `ผู้ป่วย: ${p.fullName}\n` : ``) +
        dueList.map((d, i) => `${i + 1}. ${d.label}`).join('\n');

      if (VERBOSE) {
        this.logger.log(`push → ${lineUserId}: ${dueList.length} item(s)`);
        console.log(`[CRON] push → ${lineUserId}: ${dueList.length} item(s)`);
      }

      try {
        await pushText(lineUserId, message);
      } catch (e: any) {
        this.logger.error(
          `LINE push error to ${lineUserId}: ${e?.message || e}`,
        );
        console.error(
          `[CRON] LINE push error to ${lineUserId}:`,
          e?.message || e,
        );
        continue;
      }

      // บันทึก log กันซ้ำ
      try {
        await this.prisma.$transaction(
          dueList.map((d) =>
            this.prisma.notificationLog.create({
              data: { patientId: p.id, prescriptionId: d.rxId, hhmm: d.hhmm },
            }),
          ),
        );
      } catch (e) {
        this.logger.error(
          `Create NotificationLog failed for ${lineUserId}`,
          e as any,
        );
        console.error('[CRON] Create NotificationLog failed', e);
      }

      totalUsersPushed += 1;
      totalItemsDue += dueList.length;
    }

    return { users: totalUsersPushed, items: totalItemsDue };
  }
}

/* ========= Helpers: เวลา/โซน ========= */

function formatYMDInTz(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(date); // "YYYY-MM-DD"
}

function formatHHMMInTz(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  return fmt.format(date); // "HH:mm"
}

/* ========= Helper: LINE push ========= */

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
