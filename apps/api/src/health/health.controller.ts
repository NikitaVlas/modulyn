import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import type { HealthResponse, ReadinessResponse } from '@modulyn/contracts';
import { Public } from '../auth/decorators.js';
import { DatabaseService } from '../database/database.service.js';

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly database: DatabaseService) {}
  @Get()
  live(): HealthResponse { return { status: 'ok', service: 'modulyn-api' }; }
  @Get('ready')
  async ready(): Promise<ReadinessResponse> {
    try { await this.database.ping(); }
    catch { throw new ServiceUnavailableException('Service unavailable'); }
    return { status: 'ready', database: 'up' };
  }
}
