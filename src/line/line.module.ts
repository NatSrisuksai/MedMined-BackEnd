import { Module } from '@nestjs/common';
import { LineService } from 'src/line/line.service';

@Module({
  providers: [LineService],
  exports: [LineService],
})
export class LineModule {}
