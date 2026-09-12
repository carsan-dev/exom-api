import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { databasePoolConfig } from './pool-config';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  // Jobs pin a PostgreSQL transaction without Prisma's interactive callback deadline.
  readonly postgresqlPool: Pool;

  constructor() {
    const pool = new Pool(databasePoolConfig());

    super({
      adapter: new PrismaPg(pool),
      log: [],
    });
    this.postgresqlPool = pool;
    pool.on('error', () =>
      this.logger.error('Database idle connection failed'),
    );
  }

  async onModuleInit() {
    try {
      await this.$connect();
      // adapter-pg may connect lazily; readiness must verify a real connection.
      await this.postgresqlPool.query('SELECT 1');
    } catch {
      await this.postgresqlPool.end();
      throw new Error(
        'Database connection failed; verify connectivity and TLS configuration',
      );
    }
    this.logger.log('Database connected');
  }

  async onModuleDestroy() {
    await this.$disconnect();
    if (!this.postgresqlPool.ended) await this.postgresqlPool.end();
    this.logger.log('Database disconnected');
  }
}
