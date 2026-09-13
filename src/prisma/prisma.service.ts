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
import { startupError } from '../startup-error';

function createPool() {
  try {
    return new Pool(databasePoolConfig());
  } catch (error) {
    throw startupError('database-configuration', error);
  }
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  // Jobs pin a PostgreSQL transaction without Prisma's interactive callback deadline.
  readonly postgresqlPool: Pool;

  constructor() {
    const pool = createPool();

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
    } catch (error) {
      const failure = startupError('database', error);
      try {
        await this.postgresqlPool.end();
      } catch {
        this.logger.error(
          'Database startup cleanup failed; original failure preserved',
        );
      }
      throw failure;
    }
    this.logger.log('Database connected');
  }

  async onModuleDestroy() {
    await this.$disconnect();
    if (!this.postgresqlPool.ended) await this.postgresqlPool.end();
    this.logger.log('Database disconnected');
  }
}
