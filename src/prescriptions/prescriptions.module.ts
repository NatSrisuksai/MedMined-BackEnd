import { Module } from '@nestjs/common';
import { PrescriptionsController } from './prescriptions.controller';
import { LineService } from 'src/line/line.service';

@Module({
  imports: [LineService],
  controllers: [PrescriptionsController],
  providers: [],
})
export class PrescriptionModule {}
