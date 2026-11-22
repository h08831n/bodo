import { Controller, Get, Res, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { HealthService } from './health.service';
import { Public } from '../common/decorators/auth.decorators';

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('live')
  getLive() {
    return this.healthService.checkLive();
  }

  @Get('ready')
  async getReady(@Res({ passthrough: false }) res: Response) {
    const { isReady, data } = await this.healthService.checkReady();
    const status = isReady ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;
    return res.status(status).json(data);
  }
}
