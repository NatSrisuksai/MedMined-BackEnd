import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  NotFoundException,
  Param,
  Post,
  Logger,
} from '@nestjs/common';
import { LineService } from 'src/line/line.service';
import { PrismaService } from 'src/prisma/prisma.service';

type CreatePrescriptionDTO = {
  // ข้อมูลผู้ป่วยจากฟอร์ม
  patientFirstName: string;
  patientLastName: string;
  age?: number;
  hn?: string;

  // ข้อมูลใบยา
  issueDate: string; // ISO string (เช่น '2025-09-15')
  drugName: string;
  quantityTotal?: number; // จำนวนเม็ดทั้งหมดในคอร์ส
  method?: 'BEFORE_MEAL' | 'AFTER_MEAL' | 'WITH_MEAL' | 'NONE';
  timezone?: string; // default Asia/Bangkok
  startDate: string; // ISO (เริ่มคอร์ส)
  endDate?: string | null; // ISO หรือ null
  notes?: string;

  // ตารางมื้อ/ช่วง (เช้า/กลางวัน/เย็น/ก่อนนอน/กำหนดเอง)
  periods: Array<{
    period: 'MORNING' | 'NOON' | 'EVENING' | 'BEDTIME' | 'CUSTOM';
    hhmm?: string; // ถ้าไม่ใส่ จะ map เป็นเวลามาตรฐานตาม period
    pills: number; // จำนวนเม็ดในมื้อนี้
  }>;
};

@Controller()
export class PrescriptionsController {
  private readonly logger = new Logger(PrescriptionsController.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly line: LineService,
  ) {}

  /** สร้างใบยาใหม่ + ผูกกับผู้ป่วย (อ้างอิงจาก HN ถ้ามี ไม่งั้นสร้างใหม่) */
  @Post('/api/prescriptions')
  async create(@Body() dto: CreatePrescriptionDTO) {
    if (!dto.patientFirstName || !dto.patientLastName) {
      throw new BadRequestException(
        'patientFirstName and patientLastName are required',
      );
    }
    if (!dto.drugName) throw new BadRequestException('drugName is required');
    if (!dto.issueDate || !dto.startDate)
      throw new BadRequestException('issueDate and startDate are required');
    if (!Array.isArray(dto.periods) || dto.periods.length === 0) {
      throw new BadRequestException('periods is required');
    }

    const fullName = `${dto.patientFirstName} ${dto.patientLastName}`.trim();
    const timezone = dto.timezone || 'Asia/Bangkok';
    const opaqueId = genOpaqueId();

    const patient = await this.prisma.patient.upsert({
      where: dto.hn ? { hn: dto.hn } : { hn: '___NO_SUCH_HN___' }, // ถ้าไม่มี HN จะไม่ match → ไป create
      update: {
        firstName: dto.patientFirstName,
        lastName: dto.patientLastName,
        fullName,
        age: typeof dto.age === 'number' ? dto.age : null,
      },
      create: {
        firstName: dto.patientFirstName,
        lastName: dto.patientLastName,
        fullName,
        age: typeof dto.age === 'number' ? dto.age : null,
        hn: dto.hn || null,
      },
      select: { id: true, fullName: true },
    });

    const created = await this.prisma.prescription.create({
      data: {
        patientId: patient.id,
        opaqueId,
        issueDate: new Date(dto.issueDate),
        drugName: dto.drugName,
        quantityTotal: dto.quantityTotal ?? null,
        method: dto.method ?? null,
        timezone,
        startDate: new Date(dto.startDate),
        endDate: dto.endDate ? new Date(dto.endDate) : null,
        notes: dto.notes ?? null,
        schedules: { create: mapFormToSchedules(dto.periods) },
      },
      include: { schedules: true },
    });

    return {
      ok: true,
      opaqueId,
      prescriptionId: created.id,
      patientId: patient.id,
    };
  }

  /** สแกน/เรียก activate → adopt ผูกบัญชี + ตีตรา received + บันทึกเข้าคลัง + พุชสรุปยา */
  @Post('/api/p/:opaqueId/activate')
  async activate(
    @Param('opaqueId') opaqueId: string,
    @Body() body: { lineUserId: string },
  ) {
    const lineUserId = (body?.lineUserId || '').trim();
    if (!lineUserId) throw new BadRequestException('lineUserId is required');

    const { rx, patient } = await this.prisma.$transaction(async (tx) => {
      const rx0 = await tx.prescription.findUnique({
        where: { opaqueId },
        include: { patient: true, schedules: true },
      });
      if (!rx0) throw new NotFoundException('Prescription not found');

      const owner = await tx.patient.findFirst({
        where: { lineUserId },
        select: { id: true },
      });

      // ผูก/ย้ายใบยาให้ตรง owner
      if (!rx0.patient.lineUserId) {
        if (owner && owner.id !== rx0.patientId) {
          // ย้ายใบยาไปหา patient เจ้าของ lineUserId
          await tx.prescription.update({
            where: { id: rx0.id },
            data: { patientId: owner.id, receivedAt: new Date() },
          });
          await tx.patient.update({
            where: { id: owner.id },
            data: { recentActivatedPrescriptionId: rx0.id },
          });
        } else {
          // ผูก LINE กับ patient ของใบยา
          await tx.patient.update({
            where: { id: rx0.patientId },
            data: { lineUserId, recentActivatedPrescriptionId: rx0.id },
          });
          await tx.prescription.update({
            where: { id: rx0.id },
            data: { receivedAt: rx0.receivedAt ?? new Date() },
          });
        }
      } else {
        if (rx0.patient.lineUserId !== lineUserId) {
          throw new ConflictException(
            'PRESCRIPTION_BOUND_TO_OTHER_LINE_ACCOUNT',
          );
        }
        await tx.patient.update({
          where: { id: rx0.patientId },
          data: { recentActivatedPrescriptionId: rx0.id },
        });
        await tx.prescription.update({
          where: { id: rx0.id },
          data: { receivedAt: rx0.receivedAt ?? new Date() },
        });
      }

      // บันทึกเข้าคลังยา (เปิดแจ้งเตือน)
      const ownerId = owner?.id ?? rx0.patientId;
      await tx.medicationInventory.upsert({
        where: {
          patientId_prescriptionId: {
            patientId: ownerId,
            prescriptionId: rx0.id,
          },
        },
        create: { patientId: ownerId, prescriptionId: rx0.id, isActive: true },
        update: { isActive: true },
      });

      const rx = await tx.prescription.findUnique({
        where: { id: rx0.id },
        include: { patient: true, schedules: true },
      });

      return { rx: rx!, patient: rx!.patient };
    });

    // พุชสรุปใบยา
    const message = buildRxSummary(
      {
        drugName: rx.drugName,
        quantityTotal: rx.quantityTotal,
        method: (rx as any).method || null,
        timezone: rx.timezone,
        startDate: rx.startDate,
        endDate: rx.endDate ?? null,
        notes: rx.notes ?? null,
        schedules: rx.schedules.map((s) => ({
          period: s.period,
          hhmm: s.hhmm,
          pills: s.pills,
        })),
      },
      patient?.fullName || null,
    );

    await this.line.pushText(
      // ผู้ใช้ปลายทาง
      patient?.lineUserId || body.lineUserId,
      message,
    );

    return { ok: true };
  }
}

/** map periods (จากฟอร์ม) → DoseSchedule.create[] */
function mapFormToSchedules(
  periods: Array<{ period: any; hhmm?: string; pills: number }>,
) {
  const defaults: Record<string, string> = {
    MORNING: '08:00',
    NOON: '12:00',
    EVENING: '18:00',
    BEDTIME: '22:00',
  };
  return periods
    .map((it) => ({
      period: it.period,
      hhmm: it.hhmm || defaults[it.period] || '08:00',
      pills: Number(it.pills || 0) || 0,
    }))
    .filter((x) => x.pills > 0);
}

function genOpaqueId() {
  // 8 hex ตัวอักษรแบบอ่านง่าย
  return Math.random().toString(16).slice(2, 10);
}

function buildRxSummary(
  rx: {
    drugName: string;
    quantityTotal: number | null;
    method: string | null;
    timezone: string;
    startDate: Date;
    endDate: Date | null;
    notes: string | null;
    schedules: { period: string; hhmm: string; pills: number }[];
  },
  fullName: string | null,
) {
  const periodLabel = (p: string) =>
    p === 'MORNING'
      ? 'เช้า'
      : p === 'NOON'
        ? 'กลางวัน'
        : p === 'EVENING'
          ? 'เย็น'
          : p === 'BEDTIME'
            ? 'ก่อนนอน'
            : 'อื่นๆ';
  const scheduleLines = rx.schedules
    .filter((s) => !!s.hhmm)
    .sort((a, b) => a.hhmm.localeCompare(b.hhmm))
    .map((s) => `• ${periodLabel(s.period)} ${s.hhmm} — ${s.pills} เม็ด`)
    .join('\n');

  const methodTh =
    rx.method === 'BEFORE_MEAL'
      ? 'ก่อนอาหาร'
      : rx.method === 'AFTER_MEAL'
        ? 'หลังอาหาร'
        : rx.method === 'WITH_MEAL'
          ? 'พร้อมอาหาร'
          : '-';

  const lines = [
    '📋 รายละเอียดยา',
    fullName ? `ผู้ป่วย: ${fullName}` : null,
    `ชื่อยา: ${rx.drugName}`,
    typeof rx.quantityTotal === 'number'
      ? `จำนวนเม็ดยาทั้งหมด: ${rx.quantityTotal}`
      : null,
    `วิธีรับประทาน: ${methodTh}`,
    `เริ่ม: ${formatYMD(rx.startDate)}${rx.endDate ? ` ถึง ${formatYMD(rx.endDate)}` : ''}`,
    `เขตเวลา: ${rx.timezone}`,
    'ตารางมื้อ:',
    scheduleLines || '• -',
    rx.notes ? `หมายเหตุ: ${rx.notes}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

function formatYMD(d: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}
