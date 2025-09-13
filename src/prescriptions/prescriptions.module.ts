import { Module } from '@nestjs/common';
import { PrescriptionsController } from './prescriptions.controller';

@Module({
  imports: [],
  controllers: [PrescriptionsController],
  providers: [],
})
export class PrescriptionModule {}
