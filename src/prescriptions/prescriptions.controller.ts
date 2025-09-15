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

    const { rx, patient } = await this.prisma.$transaction(async (tx) => {
      // 1) หาใบยาตาม opaqueId
      const rx0 = await tx.prescription.findUnique({
        where: { opaqueId },
        include: { patient: true },
      });
      if (!rx0) throw new NotFoundException('Prescription not found');

      // 2) หา "เจ้าของ LINE นี้" (ถ้ามี)
      const owner = await tx.patient.findFirst({
        where: { lineUserId },
        select: { id: true },
      });

      // CASE A) ใบยานี้ยังไม่ผูก LINE กับเจ้าของ (patient ของใบยาไม่มี lineUserId)
      if (!rx0.patient.lineUserId) {
        if (owner && owner.id !== rx0.patientId) {
          // ✅ adopt: ย้ายใบยาไปอยู่กับ patient เจ้าของ lineUserId
          await tx.prescription.update({
            where: { id: rx0.id },
            data: { patientId: owner.id },
          });
          await tx.patient.update({
            where: { id: owner.id },
            data: { recentActivatedPrescriptionId: rx0.id },
          });

          // รีเฟรชข้อมูลหลังย้าย
          const rx = await tx.prescription.findUnique({
            where: { id: rx0.id },
            include: { patient: true },
          });
          return { rx: rx!, patient: rx!.patient };
        }

        // ไม่มี owner (ยังไม่เคยผูก LINE ที่ไหน) → ผูกกับ patient ของใบยานี้
        await tx.patient.update({
          where: { id: rx0.patientId },
          data: {
            lineUserId,
            recentActivatedPrescriptionId: rx0.id,
          },
        });
        const patient = await tx.patient.findUnique({
          where: { id: rx0.patientId },
        });
        return { rx: rx0, patient: patient! };
      }

      // CASE B) ใบยานี้ผูก LINE แล้ว แต่ไม่ตรงกับที่ส่งมา → block
      if (rx0.patient.lineUserId !== lineUserId) {
        throw new ConflictException('PRESCRIPTION_BOUND_TO_OTHER_LINE_ACCOUNT');
      }

      // CASE C) ใบยานี้ผูกกับ LINE นี้อยู่แล้ว → อัปเดต recentActivated และไปต่อ
      await tx.patient.update({
        where: { id: rx0.patientId },
        data: { recentActivatedPrescriptionId: rx0.id },
      });
      const patient = await tx.patient.findUnique({
        where: { id: rx0.patientId },
      });
      return { rx: rx0, patient: patient! };
    });

    // 3) พุชทุกครั้งที่ activate สำเร็จ
    const message = buildPrescriptionSummary(rx, patient?.fullName);
    try {
      await this.line.pushText(lineUserId, message);
    } catch (e: any) {
      throw e;
    }
    return { ok: true };
  }
}

function buildPrescriptionSummary(
  rx: {
    drugName: string;
    strength: string | null;
    instruction: string | null;
    timesCsv: string | null;
    notes: string | null;
  },
  fullName?: string | null,
) {
  const times = (rx.timesCsv || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(', ');
  const parts = [
    'ข้อมูลยาของคุณ',
    fullName ? `• ผู้ป่วย: ${fullName}` : null,
    `• ชื่อยา: ${rx.drugName}${rx.strength ? ` (${rx.strength})` : ''}`,
    `• วิธีใช้: ${rx.instruction || '-'}`,
    `• เวลา: ${times || '-'}`,
    rx.notes ? `• หมายเหตุ: ${rx.notes}` : null,
  ].filter(Boolean);
  return parts.join('\n');
}
