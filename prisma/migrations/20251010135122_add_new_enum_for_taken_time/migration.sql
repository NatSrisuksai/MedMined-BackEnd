/*
  Warnings:

  - The values [BEFORE_MEAL,AFTER_MEAL,WITH_MEAL,NONE] on the enum `MealRelation` will be removed. If these variants are still used in the database, this will fail.
  - Changed the type of `period` on the `DoseSchedule` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "public"."MealRelation_new" AS ENUM ('BEFORE_BREAKFAST', 'AFTER_BREAKFAST', 'BEFORE_LUNCH', 'AFTER_LUNCH', 'BEFORE_DINNER', 'AFTER_DINNER', 'BEFORE_BED', 'CUSTOM');
ALTER TABLE "public"."Prescription" ALTER COLUMN "method" TYPE "public"."MealRelation_new" USING ("method"::text::"public"."MealRelation_new");
ALTER TABLE "public"."DoseSchedule" ALTER COLUMN "period" TYPE "public"."MealRelation_new" USING ("period"::text::"public"."MealRelation_new");
ALTER TYPE "public"."MealRelation" RENAME TO "MealRelation_old";
ALTER TYPE "public"."MealRelation_new" RENAME TO "MealRelation";
DROP TYPE "public"."MealRelation_old";
COMMIT;

-- AlterTable
ALTER TABLE "public"."DoseSchedule" DROP COLUMN "period",
ADD COLUMN     "period" "public"."MealRelation" NOT NULL;
