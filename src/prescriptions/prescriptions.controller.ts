// src/prescriptions.controller.ts
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { LineService } from 'src/line/line.service';
import { PrismaService } from 'src/prisma/prisma.service';

@Controller('api')
export class PrescriptionsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly line: LineService,
  ) {}

  /**
   * POST /api/prescriptions
   * -----------------------
   * สร้างใบยา (Prescription) ใหม่ในระบบ
   * - ถ้าไม่มี patientId จะสร้างคนไข้ใหม่อัตโนมัติ (ใช้ fullName หรือ 'Unknown')
   * - สุ่ม opaqueId (ใช้ gen QR/ลิงก์ให้ผู้ป่วยเปิดใน LINE)
   * - บันทึกชื่อยา ขนาดยา วิธีใช้ วันที่เริ่ม-สิ้นสุด โซนเวลา เวลาในการกินยา (array → string)
   * - คืนค่า id และ opaqueId ของใบยา
   */
  @Post('prescriptions')
  async create(
    @Body()
    dto: {
      patientId?: string;
      fullName?: string;
      drugName: string;
      strength?: string;
      instruction: string;
      startDate: string;
      endDate?: string;
      timezone?: string;
      times: string[];
      notes?: string;
    },
  ) {
    let patientId = dto.patientId;
    if (!patientId) {
      // ถ้าไม่มี patientId → สร้าง Patient ใหม่
      const p = await this.prisma.patient.create({
        data: { fullName: dto.fullName || 'Unknown' },
      });
      patientId = p.id;
    }

    // gen รหัสลับสั้น ๆ เอาไว้ทำลิงก์/QR
    const opaqueId = randomBytes(4).toString('hex'); // 8 ตัว

    const rx = await this.prisma.prescription.create({
      data: {
        patientId,
        opaqueId,
        drugName: dto.drugName,
        strength: dto.strength || null,
        instruction: dto.instruction,
        startDate: new Date(dto.startDate),
        endDate: dto.endDate ? new Date(dto.endDate) : null,
        timezone: dto.timezone || 'Asia/Bangkok',
        timesCsv: dto.times.join(','), // array → string
        notes: dto.notes || null,
      },
      select: { id: true, opaqueId: true }, // คืนเฉพาะ id และ opaqueId
    });

    return rx; // ตัวอย่าง: { id: "uuid", opaqueId: "a1b2c3d4" }
  }

  /**
   * GET /api/p/:opaqueId
   * --------------------
   * ใช้ดึงข้อมูลใบยาตาม opaqueId
   * - เวลา user สแกน QR หรือเปิดลิงก์ /p/[opaqueId]
   * - จะได้รายละเอียดใบยาพร้อมข้อมูลคนไข้ (patient)
   */
  @Get('p/:opaqueId')
  async getByOpaque(@Param('opaqueId') opaqueId: string) {
    const rx = await this.prisma.prescription.findUnique({
      where: { opaqueId },
      include: { patient: true }, // join patient มาด้วย
    });
    if (!rx) throw new NotFoundException();
    return rx;
  }

  /**
   * POST /api/p/:opaqueId/activate
   * ------------------------------
   * ใช้เชื่อม userId จาก LINE กับ patient
   * - เรียกจากหน้า LIFF หลังจากที่ user เปิด /p/[opaqueId]
   * - จะได้ userId ของ LINE จาก liff.getProfile()
   * - ถ้ายังไม่มี lineUserId ผูกกับ patient → update ให้มี
   * - ใช้สำหรับ push แจ้งเตือนทานยาผ่าน LINE ในภายหลัง
   */
  @Post('p/:opaqueId/activate')
  async activate(
    @Param('opaqueId') opaqueId: string,
    @Body() body: { lineUserId: string },
  ) {
    const lineUserId = (body?.lineUserId || '').trim();
    if (!lineUserId) throw new BadRequestException('lineUserId is required');

    // ทำให้เป็น idempotent + กันชนกันด้วย unique(lineUserId) ที่ Patient
    const { rx, patient } = await this.prisma.$transaction(async (tx) => {
      // 1) หา prescription จาก opaqueId
      const rx = await tx.prescription.findUnique({
        where: { opaqueId },
        include: { patient: true },
      });
      if (!rx) throw new NotFoundException('Prescription not found');

      // 2) เช็คว่ามีใครใช้ lineUserId นี้อยู่แล้วหรือไม่
      const exists = await tx.patient.findFirst({
        where: { lineUserId },
        select: { id: true, fullName: true },
      });

      // 3) กรณี patient ของใบยานี้ยังไม่ถูก bind -> bind ได้ แต่ต้องไม่ชนกับคนอื่น
      if (!rx.patient.lineUserId) {
        if (exists && exists.id !== rx.patientId) {
          // มีคนอื่นครอบครอง lineUserId นี้แล้ว
          throw new ConflictException(
            'This LINE account is already bound to another patient.',
          );
        }
        await tx.patient.update({
          where: { id: rx.patientId },
          data: { lineUserId },
        });
      } else {
        // 4) กรณีเคย bind แล้ว:
        if (rx.patient.lineUserId !== lineUserId) {
          // ใบยอนี้ผูกกับ LINE อีกคนอยู่
          throw new ConflictException(
            'This prescription is already bound to a different LINE account.',
          );
        }
        // ถ้าเหมือนเดิม ถือว่า idempotent -> ไม่ต้องอัปเดต
      }

      // รีเฟรช patient หลังอัปเดต (กันกรณีเพิ่ง bind)
      const patient = await tx.patient.findUnique({
        where: { id: rx.patientId },
      });

      return { rx, patient };
    });

    // 5) สร้างสรุปข้อความยา แล้ว push หา lineUserId
    const message = buildPrescriptionSummary(
      rx.drugName,
      rx.strength,
      rx.instruction,
      rx.timesCsv,
      rx.notes,
      patient?.fullName,
    );

    await this.line.pushText(lineUserId, message);

    return { ok: true };
  }
}

function buildPrescriptionSummary(
  drugName: string,
  strength?: string | null,
  instruction?: string | null,
  timesCsv?: string | null,
  notes?: string | null,
  fullName?: string | null,
) {
  const times = (timesCsv || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(', ');

  const lines: string[] = [];
  lines.push('ข้อมูลยาของคุณ');

  if (fullName) lines.push(`• ผู้ป่วย: ${fullName}`);
  lines.push(`• ชื่อยา: ${drugName}${strength ? ` (${strength})` : ''}`);
  lines.push(`• วิธีใช้: ${instruction || '-'}`);
  lines.push(`• เวลา: ${times || '-'}`);
  if (notes) lines.push(`• หมายเหตุ: ${notes}`);

  return lines.join('\n');
}
