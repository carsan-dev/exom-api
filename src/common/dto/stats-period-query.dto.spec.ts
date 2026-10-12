import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  StatsPeriodQueryDto,
  resolveStatsPeriod,
  statsPeriodDateFilter,
  statsPeriodSql,
} from './stats-period-query.dto';

async function errorsFor(query: Record<string, unknown>) {
  const dto = plainToInstance(StatsPeriodQueryDto, query);
  return (await validate(dto)).map((error) => error.property);
}

describe('StatsPeriodQueryDto', () => {
  it('accepts no params and open bounds', async () => {
    await expect(errorsFor({})).resolves.toEqual([]);
    await expect(errorsFor({ from: '2026-10-01' })).resolves.toEqual([]);
    await expect(errorsFor({ to: '2026-10-31' })).resolves.toEqual([]);
    await expect(
      errorsFor({ from: '2026-10-05', to: '2026-10-05' }),
    ).resolves.toEqual([]);
  });

  it.each([
    { from: '2026-13-01' },
    { from: '2026-02-30' },
    { to: '2026-10-1' },
    { to: '2026-10-01T00:00:00Z' },
    { from: 'yesterday' },
  ])('rejects invalid civil dates %p', async (query) => {
    await expect(errorsFor(query)).resolves.not.toEqual([]);
  });

  it.each([
    { from: '1999-12-31' },
    { to: '2101-01-01' },
    { to: '9999-12-31' },
    { from: '0001-01-01' },
  ])('rejects years outside 2000-2100 %p', async (query) => {
    await expect(errorsFor(query)).resolves.toEqual(Object.keys(query));
  });

  it('accepts the 2000 and 2100 year boundaries', async () => {
    await expect(
      errorsFor({ from: '2000-01-01', to: '2100-12-31' }),
    ).resolves.toEqual([]);
  });

  it('rejects from after to', async () => {
    await expect(
      errorsFor({ from: '2026-10-06', to: '2026-10-05' }),
    ).resolves.toEqual(['to']);
  });
});

describe('resolveStatsPeriod', () => {
  it('returns undefined without bounds', () => {
    expect(resolveStatsPeriod({})).toBeUndefined();
  });

  it('makes to inclusive by using the next UTC midnight as exclusive bound', () => {
    const period = resolveStatsPeriod({ from: '2026-10-01', to: '2026-10-31' });
    expect(period).toEqual({
      gte: new Date('2026-10-01T00:00:00.000Z'),
      lt: new Date('2026-11-01T00:00:00.000Z'),
    });
    expect(statsPeriodDateFilter(period)).toEqual(period);
  });

  it('keeps open bounds open', () => {
    expect(resolveStatsPeriod({ to: '2026-12-31' })).toEqual({
      lt: new Date('2027-01-01T00:00:00.000Z'),
    });
    expect(resolveStatsPeriod({ from: '2026-12-31' })).toEqual({
      gte: new Date('2026-12-31T00:00:00.000Z'),
    });
  });

  it('rejects out-of-range years even without DTO validation', () => {
    expect(() => resolveStatsPeriod({ to: '9999-12-31' })).toThrow(
      BadRequestException,
    );
    expect(() => resolveStatsPeriod({ from: '1999-12-31' })).toThrow(
      BadRequestException,
    );
    expect(resolveStatsPeriod({ to: '2100-12-31' })).toEqual({
      lt: new Date('2101-01-01T00:00:00.000Z'),
    });
  });

  it('builds parameterized SQL bounds as UTC timestamps without zone', () => {
    const sql = statsPeriodSql(
      Prisma.raw('r.reviewed_at'),
      resolveStatsPeriod({ from: '2026-10-01', to: '2026-10-31' }),
    );
    expect(sql.sql).toContain('r.reviewed_at >= ?::timestamp');
    expect(sql.sql).toContain('r.reviewed_at < ?::timestamp');
    expect(sql.values).toEqual([
      '2026-10-01T00:00:00.000',
      '2026-11-01T00:00:00.000',
    ]);
    expect(statsPeriodSql(Prisma.raw('x'), undefined).sql).toBe('');
  });
});
