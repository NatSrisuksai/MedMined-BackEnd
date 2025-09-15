import { Module } from '@nestjs/common';
import { PrescriptionsController } from './prescriptions.controller';
import { LineModule } from 'src/line/line.module';

@Module({
  imports: [LineModule],
  controllers: [PrescriptionsController],
  providers: [],
})
export class PrescriptionModule {}
