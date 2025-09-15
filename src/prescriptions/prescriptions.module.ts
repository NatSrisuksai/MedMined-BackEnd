import { Module } from '@nestjs/common';
import { PrescriptionsController } from './prescriptions.controller';
import { LineModule } from 'src/line/line.module';
import { PrismaModule } from 'src/prisma/prisma.module';

@Module({
  imports: [LineModule, PrismaModule],
  controllers: [PrescriptionsController],
  providers: [],
})
export class PrescriptionModule {}
