import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Logger,
  Query,
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


  @Get('/api/prescriptions')
  async getAll(
    @Query('hn') hn?: string,
    @Query('date') date?: string,
    @Query('patientName') patientName?: string,
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
  ) {
    try {
      const where: any = {};

      if (hn) {
        where.patient = {
          hn: {
            contains: hn,
            mode: 'insensitive'
          }
        };
      }

      if (patientName) {
        where.patient = {
          ...where.patient,
          OR: [
            { firstName: { contains: patientName, mode: 'insensitive' } },
            { lastName: { contains: patientName, mode: 'insensitive' } },
            { fullName: { contains: patientName, mode: 'insensitive' } }
          ]
        };
      }

      if (date) {
        const targetDate = new Date(date);
        const nextDay = new Date(targetDate);
        nextDay.setDate(nextDay.getDate() + 1);
        
        where.issueDate = {
          gte: targetDate,
          lt: nextDay
        };
      }

      const prescriptions = await this.prisma.prescription.findMany({
        where,
        include: {
          patient: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              fullName: true,
              hn: true,
              age: true,
              lineUserId: true,
            }
          },
          schedules: {
            orderBy: { hhmm: 'asc' }
          },
          intakes: {
            select: {
              id: true,
              slotDate: true,
              hhmm: true,
              takenAt: true,
              pills: true
            }
          }
        },
        orderBy: { createdAt: 'desc' },
        take: limit ? parseInt(limit) : 100,
        skip: skip ? parseInt(skip) : 0,
      });

      const formattedPrescriptions = prescriptions.map(rx => {

      let status = 'รอรับยา';
      if (rx.patient?.lineUserId) {
        status = 'รับยาแล้ว';
      }
        
        const morning = rx.schedules.find(s => s.period === 'MORNING')?.pills || 0;
        const noon = rx.schedules.find(s => s.period === 'NOON')?.pills || 0;
        const evening = rx.schedules.find(s => s.period === 'EVENING')?.pills || 0;
        const night = rx.schedules.find(s => s.period === 'BEDTIME')?.pills || 0;
        
        const beforeMeal = rx.method === 'BEFORE_MEAL' || rx.method === 'WITH_MEAL';
        const afterMeal = rx.method === 'AFTER_MEAL' || rx.method === 'WITH_MEAL';

        return {
          id: rx.id,
          opaqueId: rx.opaqueId,
          status,
          hn: rx.patient?.hn || '',
          firstName: rx.patient?.firstName || '',
          lastName: rx.patient?.lastName || '',
          fullName: rx.patient?.fullName || '',
          age: rx.patient?.age,
          date: rx.issueDate ? this.formatDateThai(rx.issueDate) : '',
          issueDate: rx.issueDate?.toISOString().split('T')[0] || '',
          medicineName: rx.drugName,
          strength: '', // ไม่มีใน database ปัจจุบัน
          totalAmount: rx.quantityTotal || 0,
          beforeMeal,
          afterMeal,
          morning,
          noon,
          evening,
          night,
          instruction: this.buildInstruction(beforeMeal, afterMeal, morning, noon, evening, night),
          notes: rx.notes || '',
          startDate: rx.startDate?.toISOString().split('T')[0] || '',
          endDate: rx.endDate?.toISOString().split('T')[0] || '',
          receivedAt: rx.receivedAt?.toISOString() || null,
          intakeCount: rx.intakes.length,
          schedules: rx.schedules,
        };
      });

      return formattedPrescriptions;
      
    } catch (error) {
      this.logger.error('Error fetching prescriptions:', error);
      throw new BadRequestException('Failed to fetch prescriptions');
    }
  }

  @Get('/api/p/:opaqueId')
  async getByOpaqueId(@Param('opaqueId') opaqueId: string) {
    const prescription = await this.prisma.prescription.findUnique({
      where: { opaqueId },
      include: {
        patient: true,
        schedules: {
          orderBy: { hhmm: 'asc' }
        }
      }
    });

    if (!prescription) {
      throw new NotFoundException('Prescription not found');
    }

    const morning = prescription.schedules.find(s => s.period === 'MORNING')?.pills || 0;
    const noon = prescription.schedules.find(s => s.period === 'NOON')?.pills || 0;
    const evening = prescription.schedules.find(s => s.period === 'EVENING')?.pills || 0;
    const night = prescription.schedules.find(s => s.period === 'BEDTIME')?.pills || 0;

    return {
      ...prescription,
      patient: {
        fullName: prescription.patient.fullName,
        hn: prescription.patient.hn,
        age: prescription.patient.age
      },
      morning,
      noon,
      evening,
      night,
      totalAmount: prescription.quantityTotal
    };
  }

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
      where: dto.hn ? { hn: dto.hn } : { hn: '___NO_SUCH_HN___' },
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
      select: { id: true, fullName: true, hn: true },
    });

    const created = await this.prisma.prescription.create({
      data: {
        patientId: patient.id,
        opaqueId,
        issueDate: new Date(dto.issueDate),
        drugName: dto.drugName,
        quantityTotal: dto.quantityTotal ?? null,
        method: dto.method ?? null,
        timezone: timezone,
        startDate: new Date(dto.startDate),
        endDate: null,
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
      patient: {
        fullName: patient.fullName,
        hn: patient.hn,
        age: typeof dto.age === 'number' ? dto.age : null,
      },
      prescription: created,
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

      // กรณีใบยายังไม่ผูก LINE
      if (!rx0.patient.lineUserId) {
        if (owner && owner.id !== rx0.patientId) {
          // ย้ายใบยาไปยัง patient ที่ใช้ lineUserId นี้
          await tx.prescription.update({
            where: { id: rx0.id },
            data: { patientId: owner.id, receivedAt: new Date() },
          });
          await tx.patient.update({
            where: { id: owner.id },
            data: { recentActivatedPrescriptionId: rx0.id },
          });
        } else {
          // ผูก LINE ให้ patient เจ้าของใบยาเดิม
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
        // กรณีใบยาผูก LINE แล้ว แต่ไม่ใช่คนเดียวกัน → conflict
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

    await pushText(patient?.lineUserId || lineUserId, message);

    return { ok: true };
  }

  private formatDateThai(date: Date): string {
    const day = date.getDate();
    const month = date.getMonth() + 1;
    const year = date.getFullYear() + 543 - 2500; // Buddhist year (2 digits)
    return `${day}/${month}/${year.toString().slice(-2)}`;
  }

  private buildInstruction(
    beforeMeal: boolean,
    afterMeal: boolean,
    morning: number,
    noon: number,
    evening: number,
    night: number
  ): string {
    let instruction = '';
    const times: string[] = [];
    
    if (beforeMeal) instruction = 'รับประทานก่อนอาหาร ';
    else if (afterMeal) instruction = 'รับประทานหลังอาหาร ';
    
    if (morning > 0) times.push(`เช้า ${morning} เม็ด`);
    if (noon > 0) times.push(`กลางวัน ${noon} เม็ด`);
    if (evening > 0) times.push(`เย็น ${evening} เม็ด`);
    if (night > 0) times.push(`ก่อนนอน ${night} เม็ด`);
    
    return instruction + times.join(' ');
  }
}

/* ===== Helpers: สรุปข้อความ & LINE Push ===== */

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

  const methodTh =
    rx.method === 'BEFORE_MEAL'
      ? 'ก่อนอาหาร'
      : rx.method === 'AFTER_MEAL'
        ? 'หลังอาหาร'
        : rx.method === 'WITH_MEAL'
          ? 'พร้อมอาหาร'
          : '-';

  const scheduleLines = rx.schedules
    .filter((s) => !!s.hhmm)
    .sort((a, b) => a.hhmm.localeCompare(b.hhmm))
    .map((s) => `• ${periodLabel(s.period)} ${s.hhmm} — ${s.pills} เม็ด`)
    .join('\n');

  const lines = [
    '📋 รายละเอียดยา',
    fullName ? `ผู้ป่วย: ${fullName}` : null,
    `ชื่อยา: ${rx.drugName}`,
    typeof rx.quantityTotal === 'number'
      ? `จำนวนเม็ดยาทั้งหมด: ${rx.quantityTotal}`
      : null,
    `วิธีรับประทาน: ${methodTh}`,
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

async function pushText(to: string, text: string) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN!;
  const resp = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`LINE push ${resp.status}: ${body}`);
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