import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import * as crypto from 'crypto';

type CreateScheduleDto = {
  period:
    | 'BEFORE_BREAKFAST'
    | 'AFTER_BREAKFAST'
    | 'BEFORE_LUNCH'
    | 'AFTER_LUNCH'
    | 'BEFORE_DINNER'
    | 'AFTER_DINNER'
    | 'BEFORE_BED'
    | 'CUSTOM';
  hhmm?: string;
  pills: number;
  isActive?: boolean;
};

type CreatePrescriptionDto = {
  firstName?: string | null;
  lastName?: string | null;
  fullName: string;
  age?: number | null;
  hn?: string | null;

  drugName: string;
  issueDate?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  timezone?: string;
  quantityTotal?: number | null;
  notes?: string | null;

  schedules: CreateScheduleDto[];
};

@Controller('api')
export class PrescriptionsController {
  private readonly logger = new Logger(PrescriptionsController.name);
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /api/patient/suggest?hn=xxx
   * แนะนำชื่อผู้ป่วยจาก HN
   */
  @Get('patient/suggest')
  async suggestPatient(@Query('hn') hn?: string) {
    if (!hn?.trim()) {
      return { patient: null };
    }

    const patient = await this.prisma.patient.findFirst({
      where: { hn: hn.trim() },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        fullName: true,
        hn: true,
        age: true,
      },
    });

    return { patient };
  }

  /** สร้างใบยา + ตรวจสอบ HN Lock */
  @Post('prescriptions')
  async create(@Body() dto: CreatePrescriptionDto) {
    if (!dto?.fullName?.trim()) {
      throw new BadRequestException('fullName is required');
    }
    if (!dto?.drugName?.trim()) {
      throw new BadRequestException('drugName is required');
    }
    if (!Array.isArray(dto.schedules) || dto.schedules.length === 0) {
      throw new BadRequestException('schedules is required (non-empty)');
    }
    if (!dto?.hn?.trim()) {
      throw new BadRequestException('HN is required');
    }

    // ตรวจสอบ HN Lock
    if (dto.hn?.trim()) {
      const existingPatient = await this.prisma.patient.findFirst({
        where: { hn: dto.hn.trim() },
        select: {
          id: true,
          fullName: true,
          firstName: true,
          lastName: true,
          hn: true,
        },
      });

      if (existingPatient) {
        const inputFullName = dto.fullName.trim().toLowerCase();
        const existingFullName = existingPatient.fullName.trim().toLowerCase();

        if (inputFullName !== existingFullName) {
          throw new BadRequestException(
            `❌ ชื่อไม่ตรงกับ HN นี้!\n` +
              `HN "${dto.hn}" เป็นของผู้ป่วยชื่อ: "${existingPatient.fullName}"\n` +
              `กรุณาตรวจสอบชื่อหรือ HN ให้ถูกต้อง`,
          );
        }

        // HN ตรง + ชื่อตรง → ใช้ patient เดิม
        const opaqueId = genOpaqueId();
        const data: any = {
          patientId: existingPatient.id,
          opaqueId,
          drugName: dto.drugName,
          issueDate: dto.issueDate ? new Date(dto.issueDate) : null,
          timezone: dto.timezone || 'Asia/Bangkok',
          quantityTotal: dto.quantityTotal ?? null,
          notes: dto.notes ?? null,
          schedules: {
            create: dto.schedules.map((s) => ({
              period: s.period,
              hhmm: s.hhmm || canonicalHHMM(s.period),
              pills: Number(s.pills || 1),
              isActive: s.isActive !== false,
            })),
          },
        };
        if (dto.startDate) data.startDate = new Date(dto.startDate);
        if (dto.endDate) data.endDate = new Date(dto.endDate);

        const created = await this.prisma.prescription.create({
          data,
          select: { id: true, opaqueId: true, patientId: true },
        });
        await this.prisma.medicationInventory.create({
          data: {
            patientId: existingPatient.id,
            prescriptionId: created.id,
            isActive: true,
          },
        });
        return {
          ok: true,
          prescriptionId: created.id,
          opaqueId: created.opaqueId,
          patientId: created.patientId,
        };
      }
    }

    // HN ยังไม่มีในระบบ → สร้างผู้ป่วยใหม่
    const patient = await this.prisma.patient.create({
      data: {
        firstName: dto.firstName ?? null,
        lastName: dto.lastName ?? null,
        fullName: dto.fullName,
        age: dto.age ?? null,
        hn: dto.hn.trim(), // HN เป็น required แล้ว
      },
      select: { id: true },
    });

    const opaqueId = genOpaqueId();
    const data: any = {
      patientId: patient.id,
      opaqueId,
      drugName: dto.drugName,
      issueDate: dto.issueDate ? new Date(dto.issueDate) : null,
      timezone: dto.timezone || 'Asia/Bangkok',
      quantityTotal: dto.quantityTotal ?? null,
      notes: dto.notes ?? null,
      schedules: {
        create: dto.schedules.map((s) => ({
          period: s.period,
          hhmm: s.hhmm || canonicalHHMM(s.period),
          pills: Number(s.pills || 1),
          isActive: s.isActive !== false,
        })),
      },
    };
    if (dto.startDate) data.startDate = new Date(dto.startDate);
    if (dto.endDate) data.endDate = new Date(dto.endDate);

    const created = await this.prisma.prescription.create({
      data,
      select: { id: true, opaqueId: true, patientId: true },
    });
    await this.prisma.medicationInventory.create({
      data: {
        patientId: patient.id,
        prescriptionId: created.id,
        isActive: true,
      },
    });
    return {
      ok: true,
      prescriptionId: created.id,
      opaqueId: created.opaqueId,
      patientId: created.patientId,
    };
  }

  /** ดูรายการใบยา (optional) */
  @Get('prescriptions')
  async list(@Query('patientId') patientId?: string) {
    const where = patientId ? { patientId } : {};
    const items = await this.prisma.prescription.findMany({
      where,
      select: {
        id: true,
        opaqueId: true,
        drugName: true,
        issueDate: true,
        startDate: true,
        endDate: true,
        timezone: true,
        quantityTotal: true,
        notes: true,
        patient: {
          select: { id: true, fullName: true, hn: true, lineUserId: true },
        },
        schedules: {
          where: { isActive: true },
          select: { period: true, hhmm: true, pills: true },
          orderBy: { hhmm: 'asc' },
        },
        MedicationInventory: {
          select: { isActive: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return { count: items.length, items };
  }

  /**
   * Activate จาก QR/LIFF:
   * POST /api/p/:opaqueId/activate
   * body: { lineUserId: string }
   */
  @Post('p/:opaqueId/activate')
  async activate(
    @Param('opaqueId') opaqueId: string,
    @Body() body: { lineUserId: string },
  ) {
    const lineUserId = String(body?.lineUserId || '').trim();
    if (!lineUserId) throw new BadRequestException('lineUserId is required');

    const rx = await this.prisma.prescription.findFirst({
      where: { opaqueId },
      select: {
        id: true,
        patientId: true,
        drugName: true,
        timezone: true,
        quantityTotal: true,
        notes: true,
        patient: {
          select: { id: true, fullName: true, hn: true, lineUserId: true },
        },
        schedules: {
          where: { isActive: true },
          select: { period: true, hhmm: true, pills: true },
          orderBy: { hhmm: 'asc' },
        },
      },
    });
    if (!rx) throw new NotFoundException('Prescription not found');

    // bind line user ↔ patient (ถ้ายังไม่ผูก)
    if (!rx.patient.lineUserId) {
      await this.prisma.patient.update({
        where: { id: rx.patientId },
        data: { lineUserId, recentActivatedPrescriptionId: rx.id },
      });
    } else if (rx.patient.lineUserId !== lineUserId) {
      throw new BadRequestException(
        'This prescription belongs to another LINE account.',
      );
    } else {
      // อัปเดตใบล่าสุด
      await this.prisma.patient.update({
        where: { id: rx.patientId },
        data: { recentActivatedPrescriptionId: rx.id },
      });
    }

    // เพิ่มเข้าคลังยา / เปิดแจ้งเตือน
    const inv = await this.prisma.medicationInventory.upsert({
      where: {
        patientId_prescriptionId: {
          patientId: rx.patientId,
          prescriptionId: rx.id,
        },
      },
      create: {
        patientId: rx.patientId,
        prescriptionId: rx.id,
        isActive: true,
      },
      update: { isActive: true },
      select: { isActive: true },
    });

    // สร้างและส่งสรุปยา
    const summary = buildPrescriptionSummary({
      patientName: rx.patient.fullName,
      hn: rx.patient.hn ?? undefined,
      drugName: rx.drugName,
      quantityTotal: rx.quantityTotal ?? undefined,
      notes: rx.notes ?? undefined,
      timezone: rx.timezone || 'Asia/Bangkok',
      schedules: rx.schedules,
    });

    try {
      await pushText(lineUserId, summary);
    } catch (e: any) {
      this.logger.error(`LINE push error to ${lineUserId}: ${e?.message || e}`);
    }

    return { ok: true, prescriptionId: rx.id, inventoryActive: inv.isActive };
  }
}

/* ================= Helpers ================= */

function genOpaqueId() {
  return crypto.randomBytes(4).toString('hex');
}

function canonicalHHMM(period: string): string {
  switch (period) {
    case 'BEFORE_BREAKFAST':
      return '07:00';
    case 'AFTER_BREAKFAST':
      return '08:00';
    case 'BEFORE_LUNCH':
      return '11:00';
    case 'AFTER_LUNCH':
      return '12:00';
    case 'BEFORE_DINNER':
      return '15:00';
    case 'AFTER_DINNER':
      return '16:00';
    case 'BEFORE_BED':
      return '20:00';
    default:
      return '';
  }
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

function buildPrescriptionSummary(input: {
  patientName?: string;
  hn?: string;
  drugName: string;
  quantityTotal?: number;
  notes?: string;
  timezone: string;
  schedules: { period: string; hhmm: string; pills: number }[];
}) {
  const header = `📄 สรุปรายละเอียดยา\nผู้ป่วย: ${input.patientName || '-'}${input.hn ? ` (HN: ${input.hn})` : ''}`;
  const drug = `ยา: ${input.drugName}${typeof input.quantityTotal === 'number' ? ` — รวม ${input.quantityTotal} เม็ด` : ''}`;
  const tz = `โซนเวลา: ${input.timezone}`;
  const lines = input.schedules
    .slice()
    .sort((a, b) => a.hhmm.localeCompare(b.hhmm))
    .map(
      (s, i) =>
        `${i + 1}. ${periodToThai(s.period)} ${s.hhmm} — ${String(s.pills)} เม็ด`,
    )
    .join('\n');
  const note = input.notes ? `\nหมายเหตุ: ${input.notes}` : '';
  const footer = `\n\n(ระบบจะเตือนตามเวลาข้างต้น — พิมพ์ "รับประทานยาแล้ว" เพื่อบันทึกมื้อที่ถึงเวลา)`;
  return `${header}\n${drug}\n${tz}\n\nช่วงเวลากินยา:\n${lines}${note}${footer}`;
}

async function pushText(toLineUserId: string, text: string) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN!;
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      to: toLineUserId,
      messages: [{ type: 'text', text }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LINE push ${res.status}: ${body}`);
  }
}
