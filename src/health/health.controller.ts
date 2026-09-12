import {
  Controller,
  Get,
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class HealthService implements OnApplicationBootstrap, OnModuleDestroy {
  private started = false;
  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap() {
    this.started = true;
  }
  onModuleDestroy() {
    this.started = false;
  }

  async ready(): Promise<{ status: string }> {
    if (!this.started) throw new ServiceUnavailableException('Not ready');
    try {
      // pg supports query_timeout at runtime; @types/pg omits it from QueryConfig.
      const probe = { text: 'SELECT 1', query_timeout: 2000 };
      await this.prisma.postgresqlPool.query(probe);
      if (!this.started) throw new Error('Shutting down');
      return { status: 'ready' };
    } catch {
      // Deliberately do not expose connection errors or credentials.
      throw new ServiceUnavailableException('Not ready');
    }
  }
}

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  live() {
    return { status: 'alive' };
  }

  @Get('ready')
  ready() {
    return this.health.ready();
  }
}
