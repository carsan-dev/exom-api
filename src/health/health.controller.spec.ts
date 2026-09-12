import { HealthService } from './health.controller';
import { PrismaService } from '../prisma/prisma.service';

describe('readiness lifecycle', () => {
  it('is unavailable before bootstrap and after shutdown', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ value: 1 }] });
    const service = new HealthService({
      postgresqlPool: { query },
    } as unknown as PrismaService);
    await expect(service.ready()).rejects.toThrow('Not ready');
    expect(query).not.toHaveBeenCalled();
    service.onApplicationBootstrap();
    await expect(service.ready()).resolves.toEqual({ status: 'ready' });
    service.onModuleDestroy();
    await expect(service.ready()).rejects.toThrow('Not ready');
  });

  it('does not announce ready if shutdown starts during the probe', async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const query = jest.fn().mockReturnValue(pending);
    const service = new HealthService({
      postgresqlPool: { query },
    } as unknown as PrismaService);
    service.onApplicationBootstrap();
    const response = service.ready();
    service.onModuleDestroy();
    resolve();
    await expect(response).rejects.toThrow('Not ready');
  });
});
