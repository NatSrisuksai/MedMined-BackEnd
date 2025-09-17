/*
  Warnings:

  - You are about to drop the column `recent_activated_prescription_id` on the `Patient` table. All the data in the column will be lost.
  - You are about to drop the column `instruction` on the `Prescription` table. All the data in the column will be lost.
  - You are about to drop the column `strength` on the `Prescription` table. All the data in the column will be lost.
  - You are about to drop the column `timesCsv` on the `Prescription` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[hn]` on the table `Patient` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[recentActivatedPrescriptionId]` on the table `Patient` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "public"."MealRelation" AS ENUM ('BEFORE_MEAL', 'AFTER_MEAL', 'WITH_MEAL', 'NONE');

-- CreateEnum
CREATE TYPE "public"."DosePeriod" AS ENUM ('MORNING', 'NOON', 'EVENING', 'BEDTIME', 'CUSTOM');

-- DropForeignKey
ALTER TABLE "public"."Patient" DROP CONSTRAINT "Patient_recent_activated_prescription_id_fkey";

-- DropIndex
DROP INDEX "public"."NotificationLog_patientId_prescriptionId_hhmm_sentAt_idx";

-- DropIndex
DROP INDEX "public"."Patient_recent_activated_prescription_id_key";

-- AlterTable
ALTER TABLE "public"."NotificationLog" ADD COLUMN     "slotDate" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "public"."Patient" DROP COLUMN "recent_activated_prescription_id",
ADD COLUMN     "age" INTEGER,
ADD COLUMN     "firstName" TEXT,
ADD COLUMN     "hn" TEXT,
ADD COLUMN     "lastName" TEXT,
ADD COLUMN     "recentActivatedPrescriptionId" TEXT;

-- AlterTable
ALTER TABLE "public"."Prescription" DROP COLUMN "instruction",
DROP COLUMN "strength",
DROP COLUMN "timesCsv",
ADD COLUMN     "issueDate" TIMESTAMP(3),
ADD COLUMN     "method" "public"."MealRelation",
ADD COLUMN     "quantityTotal" INTEGER,
ADD COLUMN     "receivedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "public"."DoseSchedule" (
    "id" TEXT NOT NULL,
    "prescriptionId" TEXT NOT NULL,
    "period" "public"."DosePeriod" NOT NULL,
    "hhmm" TEXT NOT NULL,
    "pills" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DoseSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DoseIntake" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "prescriptionId" TEXT NOT NULL,
    "hhmm" TEXT NOT NULL,
    "slotDate" TIMESTAMP(3) NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pills" INTEGER NOT NULL,

    CONSTRAINT "DoseIntake_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DoseSchedule_prescriptionId_idx" ON "public"."DoseSchedule"("prescriptionId");

-- CreateIndex
CREATE INDEX "DoseIntake_patientId_prescriptionId_slotDate_hhmm_idx" ON "public"."DoseIntake"("patientId", "prescriptionId", "slotDate", "hhmm");

-- CreateIndex
CREATE UNIQUE INDEX "DoseIntake_patientId_prescriptionId_slotDate_hhmm_key" ON "public"."DoseIntake"("patientId", "prescriptionId", "slotDate", "hhmm");

-- CreateIndex
CREATE INDEX "NotificationLog_patientId_prescriptionId_hhmm_slotDate_sent_idx" ON "public"."NotificationLog"("patientId", "prescriptionId", "hhmm", "slotDate", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "Patient_hn_key" ON "public"."Patient"("hn");

-- CreateIndex
CREATE UNIQUE INDEX "Patient_recentActivatedPrescriptionId_key" ON "public"."Patient"("recentActivatedPrescriptionId");

-- AddForeignKey
ALTER TABLE "public"."Patient" ADD CONSTRAINT "Patient_recentActivatedPrescriptionId_fkey" FOREIGN KEY ("recentActivatedPrescriptionId") REFERENCES "public"."Prescription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DoseSchedule" ADD CONSTRAINT "DoseSchedule_prescriptionId_fkey" FOREIGN KEY ("prescriptionId") REFERENCES "public"."Prescription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DoseIntake" ADD CONSTRAINT "DoseIntake_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "public"."Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DoseIntake" ADD CONSTRAINT "DoseIntake_prescriptionId_fkey" FOREIGN KEY ("prescriptionId") REFERENCES "public"."Prescription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
