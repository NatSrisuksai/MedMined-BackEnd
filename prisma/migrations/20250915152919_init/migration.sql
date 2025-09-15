/*
  Warnings:

  - A unique constraint covering the columns `[recent_activated_prescription_id]` on the table `Patient` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "public"."Patient" ADD COLUMN     "recent_activated_prescription_id" TEXT;

-- CreateTable
CREATE TABLE "public"."MedicationInventory" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "prescriptionId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MedicationInventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."NotificationLog" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "prescriptionId" TEXT NOT NULL,
    "hhmm" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MedicationInventory_patientId_idx" ON "public"."MedicationInventory"("patientId");

-- CreateIndex
CREATE INDEX "MedicationInventory_prescriptionId_idx" ON "public"."MedicationInventory"("prescriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "MedicationInventory_patientId_prescriptionId_key" ON "public"."MedicationInventory"("patientId", "prescriptionId");

-- CreateIndex
CREATE INDEX "NotificationLog_patientId_prescriptionId_hhmm_sentAt_idx" ON "public"."NotificationLog"("patientId", "prescriptionId", "hhmm", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "Patient_recent_activated_prescription_id_key" ON "public"."Patient"("recent_activated_prescription_id");

-- AddForeignKey
ALTER TABLE "public"."Patient" ADD CONSTRAINT "Patient_recent_activated_prescription_id_fkey" FOREIGN KEY ("recent_activated_prescription_id") REFERENCES "public"."Prescription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MedicationInventory" ADD CONSTRAINT "MedicationInventory_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "public"."Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MedicationInventory" ADD CONSTRAINT "MedicationInventory_prescriptionId_fkey" FOREIGN KEY ("prescriptionId") REFERENCES "public"."Prescription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
