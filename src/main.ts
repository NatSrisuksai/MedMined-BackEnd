import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  // คุณมี rawBody อยู่แล้วสำหรับ LINE webhook
  const app = await NestFactory.create(AppModule, { rawBody: true });

  const allowed = [
    'http://localhost:3000', // Next dev
    'http://localhost:8888', // ถ้าใช้ Netlify dev
    'https://med-mind-sepia.vercel.app/',
    process.env.FRONTEND_ORIGIN, // e.g. https://your-frontend.vercel.app
  ].filter(Boolean) as string[];

  app.enableCors({ origin: true })

  await app.listen(process.env.PORT || 4000);
}
bootstrap();
