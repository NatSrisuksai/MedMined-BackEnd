import { Controller, Get, Query } from '@nestjs/common';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter';
import { PrismaService } from 'src/prisma/prisma.service';

dayjs.extend(utc);
dayjs.extend(isSameOrBefore);
dayjs.extend(isSameOrAfter);
@Controller('api/cron')
export class CronController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('tick')
  async tick(@Query('secret') secret: string) {
    if (secret !== process.env.CRON_SECRET)
      return { ok: false, reason: 'forbidden' };

    // 1) ดึงผู้ใช้ที่ผูก lineUserId แล้ว + มีของในคลัง isActive
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

    // 2) per patient → คัดเฉพาะใบยาที่ "ถึงเวลา" ตาม timezone ของแต่ละใบ
    for (const p of patients) {
      const dueList: { rxId: string; label: string; hhmm: string }[] = [];

      for (const inv of p.inventories) {
        const rx = inv.prescription;
        if (!rx) continue;

        // ตรวจช่วงวันที่
        const nowTzStr = new Date().toLocaleString('en-US', {
          timeZone: rx.timezone || 'Asia/Bangkok',
        });
        const nowTz = new Date(nowTzStr);
        const today = dayjs(nowTz).startOf('day');

        const startOk = dayjs(rx.startDate)
          .startOf('day')
          .isSameOrBefore(today);
        const endOk =
          !rx.endDate || dayjs(rx.endDate).startOf('day').isSameOrAfter(today);
        if (!startOk || !endOk) continue;

        // เวลา HH:mm ตอนนี้ใน timezone ของใบยา
        const hhmmNow = `${String(nowTz.getHours()).padStart(2, '0')}:${String(nowTz.getMinutes()).padStart(2, '0')}`;

        // เทียบกับ timesCsv
        const times = (rx.timesCsv || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);

        if (times.includes(hhmmNow)) {
          // กันยิงซ้ำภายใน 1 นาที
          const recent = await this.prisma.notificationLog.findFirst({
            where: {
              patientId: p.id,
              prescriptionId: rx.id,
              hhmm: hhmmNow,
              sentAt: { gte: new Date(Date.now() - 60_000) },
            },
          });
          if (recent) continue;

          const label = `${rx.drugName}${rx.strength ? ` (${rx.strength})` : ''} — ${rx.instruction || '-'}`;
          dueList.push({ rxId: rx.id, label, hhmm: hhmmNow });
        }
      }

      if (dueList.length === 0) continue;

      // 3) รวมข้อความเดียว
      const msg = `ถึงเวลาใช้ยาแล้ว
${p.fullName ? `ผู้ป่วย: ${p.fullName}\n` : ''}${dueList.map((d, i) => `${i + 1}. ${d.label}`).join('\n')}`;

      // 4) พุชทีเดียว
      await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to: p.lineUserId,
          messages: [{ type: 'text', text: msg }],
        }),
      });

      // 5) บันทึก log กันยิงซ้ำ (ต่อใบ/ต่อ hhmm)
      await this.prisma.$transaction(
        dueList.map((d) =>
          this.prisma.notificationLog.create({
            data: { patientId: p.id, prescriptionId: d.rxId, hhmm: d.hhmm },
          }),
        ),
      );
    }

    return { ok: true, at: new Date().toISOString() };
  }
}
