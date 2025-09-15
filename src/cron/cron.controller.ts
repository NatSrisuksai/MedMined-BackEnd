import { Controller, Get, Logger, Query, Req } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

// ====== Guard กันงานซ้อน (in-memory) ======
let running = false;
let startedAt = 0; // ms
const MAX_RUN_MS = 55_000; // ป้องกันค้างนานเกินไป

@Controller('api/cron')
export class CronController {
  private readonly logger = new Logger(CronController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Get('tick')
  async tick(@Req() req: any, @Query('secret') secretQ?: string) {
    // --- check secret (query หรือ header) ---
    const secretH = req.headers['x-cron-secret'] as string | undefined;
    const okSecret =
      (secretQ && secretQ === process.env.CRON_SECRET) ||
      (secretH && secretH === process.env.CRON_SECRET);
    if (!okSecret) {
      return { ok: false, reason: 'forbidden' };
    }

    // --- guard กันงานซ้อน ---
    const nowMs = Date.now();
    if (running && nowMs - startedAt < MAX_RUN_MS) {
      this.logger.warn('Skip: cron is already running');
      return { ok: false, reason: 'cron-is-running' };
    }
    if (running && nowMs - startedAt >= MAX_RUN_MS) {
      // safety: reset flag ถ้าค้างนานผิดปกติ
      this.logger.warn('Reset stale cron flag');
      running = false;
    }

    running = true;
    startedAt = nowMs;

    try {
      const result = await this.processTick();
      return { ok: true, ...result, at: new Date().toISOString() };
    } catch (err: any) {
      this.logger.error('Cron tick failed', err?.stack || err);
      return { ok: false, error: String(err?.message || err) };
    } finally {
      running = false;
      startedAt = 0;
    }
  }

  // ====== งานหลักของ cron (sequential) ======
  private async processTick() {
    // 1) ดึงผู้ใช้ที่มี lineUserId และมีรายการในคลังยา (isActive)
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

    let totalUsersPushed = 0;
    let totalItemsDue = 0;

    // 2) เดินทีละคน (sequential) เพื่อใช้ connection ต่ำสุด
    for (const p of patients) {
      const lineUserId = p.lineUserId!;
      const dueList: { rxId: string; label: string; hhmm: string }[] = [];

      // 2.1 รวมคิวแจ้งเตือนของผู้ใช้คนนี้
      for (const inv of p.inventories) {
        const rx = inv.prescription;
        if (!rx) continue;

        const tz = rx.timezone || 'Asia/Bangkok';

        // วันนี้ (ที่ timezone ของใบยา)
        const todayYmd = formatYMDInTz(new Date(), tz);

        const startYmd = formatYMDInTz(new Date(rx.startDate), tz);
        const endYmd = rx.endDate
          ? formatYMDInTz(new Date(rx.endDate), tz)
          : null;

        // startOk: startDate <= today (เทียบเป็น YYYY-MM-DD)
        const startOk = startYmd <= todayYmd;
        // endOk: today <= endDate (หรือไม่กำหนด end)
        const endOk = !endYmd || todayYmd <= endYmd;
        if (!startOk || !endOk) continue;

        // เวลา HH:mm ตอนนี้ใน timezone ของใบยา
        const hhmmNow = formatHHMMInTz(new Date(), tz);

        // เทียบกับ timesCsv (“08:00,20:00”)
        const times = (rx.timesCsv || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);

        if (!times.includes(hhmmNow)) continue;

        // กันยิงซ้ำภายใน 60 วินาที สำหรับใบยาเดียวกัน/เวลาเดียวกัน
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

      // 2.2 ส่งรวมข้อความเดียวให้ผู้ใช้รายนี้
      const message =
        `ถึงเวลาใช้ยาแล้ว\n` +
        (p.fullName ? `ผู้ป่วย: ${p.fullName}\n` : ``) +
        dueList.map((d, i) => `${i + 1}. ${d.label}`).join('\n');

      try {
        await pushText(lineUserId, message);
      } catch (e: any) {
        // log error แต่ไม่หยุดทั้ง cron
        this.logger.error(
          `LINE push error to ${lineUserId}: ${e?.message || e}`,
        );
        continue;
      }

      // 2.3 บันทึก log กันซ้ำ
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
      }

      totalUsersPushed += 1;
      totalItemsDue += dueList.length;
    }

    return { users: totalUsersPushed, items: totalItemsDue };
  }
}

/* ========= Helpers: เวลา/โซน ========= */

/** คืนค่า YYYY-MM-DD ใน timezone ที่กำหนด (ใช้สำหรับเทียบวันแบบไม่พึ่ง dayjs) */
function formatYMDInTz(date: Date, timeZone: string) {
  // en-CA ให้รูปแบบ YYYY-MM-DD ชัวร์
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(date); // e.g. "2025-09-15"
}

/** คืนค่า HH:mm ใน timezone ที่กำหนด */
function formatHHMMInTz(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  return fmt.format(date); // e.g. "08:00"
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
