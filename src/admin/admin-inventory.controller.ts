import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

@Controller('api/admin/inventory')
export class AdminInventoryController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * PATCH /api/admin/inventory/:prescriptionId
   * body: { isActive: boolean }
   * - เปิด/ปิดแจ้งเตือนของ prescription นั้น (ของผู้ป่วยเจ้าของใบยา)
   * - ถ้ายังไม่มี record ใน MedicationInventory จะสร้างให้ (ตอนเปิด)
   */
  @Patch(':prescriptionId')
  async toggle(
    @Param('prescriptionId') prescriptionId: string,
    @Body() body: { isActive: boolean },
  ) {
    if (typeof body?.isActive !== 'boolean') {
      throw new NotFoundException('isActive must be boolean');
    }

    // หา prescription นี้ และรู้ว่าเป็นของ patientId ไหน
    const rx = await this.prisma.prescription.findUnique({
      where: { id: prescriptionId },
      select: { id: true, patientId: true, drugName: true },
    });
    if (!rx) throw new NotFoundException('Prescription not found');

    // upsert สถานะแจ้งเตือนใน MedicationInventory
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
        isActive: body.isActive,
      },
      update: { isActive: body.isActive },
      select: { isActive: true, updatedAt: true },
    });

    return {
      ok: true,
      prescriptionId: rx.id,
      drugName: rx.drugName,
      isActive: inv.isActive,
      updatedAt: inv.updatedAt,
    };
  }
}
