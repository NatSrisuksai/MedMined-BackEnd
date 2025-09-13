// src/cron.controller.ts
import { Controller, Get, Query, BadRequestException } from '@nestjs/common';
import { LineService } from 'src/line/line.service';
import { PrismaService } from 'src/prisma/prisma.service';

@Controller('api/cron')
export class CronController {
  constructor(
    private prisma: PrismaService,
    private line: LineService,
  ) {}

  @Get('tick')
  async tick(@Query('secret') secret: string) {
    if (secret !== process.env.CRON_SECRET)
      throw new BadRequestException('invalid secret');

    const now = new Date();
    const list = await this.prisma.prescription.findMany({
      include: { patient: true },
    });

    for (const rx of list) {
      if (!rx.patient.lineUserId) continue;
      if (rx.endDate && now > rx.endDate) continue;
      if (now < rx.startDate) continue;

      const times = rx.timesCsv
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const hhmm of times) {
        if (isNowWithin1Min(now, hhmm, rx.timezone)) {
          const text = `ถึงเวลาทานยา ${rx.drugName}${rx.strength ? ' ' + rx.strength : ''} - ${rx.instruction}`;
          await this.line.pushText(rx.patient.lineUserId, text);
        }
      }
    }
    console.log('here');
    return { ok: true, at: now.toISOString() };
  }
}

function isNowWithin1Min(now: Date, hhmm: string, tz: string) {
  const [h, m] = hhmm.split(':').map(Number);
  const local = new Date(now.toLocaleString('en-US', { timeZone: tz }));
  const target = new Date(local);
  target.setHours(h, m, 0, 0);
  return Math.abs(+local - +target) <= 60_000;
}
