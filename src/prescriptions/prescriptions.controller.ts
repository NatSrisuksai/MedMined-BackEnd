// src/prescriptions.controller.ts
import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';

@Controller('api')
export class PrescriptionsController {
  constructor(private prisma: PrismaService) {}

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
    const rx = await this.prisma.prescription.findUnique({
      where: { opaqueId },
      include: { patient: true },
    });
    if (!rx) throw new NotFoundException();

    // ถ้า patient ยังไม่มี lineUserId → update
    if (!rx.patient.lineUserId && body.lineUserId) {
      await this.prisma.patient.update({
        where: { id: rx.patientId },
        data: { lineUserId: body.lineUserId },
      });
    }
    return { ok: true };
  }
}
