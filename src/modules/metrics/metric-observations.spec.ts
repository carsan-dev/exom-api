import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MetricsOverviewQueryDto } from './dto/metrics-overview-query.dto';
import { CreateRecapDto, UpdateRecapDto } from '../recaps/dto/create-recap.dto';
import { addObservation, createMetricSeries } from './metric-observations';

describe('P1 metric observations and additive contracts', () => {
  it('compares valid extrema by date, preserves zero and ignores incomplete values', () => {
    const series = createMetricSeries().find(
      (item) => item.key === 'sleep_hours',
    )!;
    for (const [date, value, quality] of [
      ['2026-09-15', 8, 'complete'],
      ['2026-09-01', 0, 'complete'],
      ['2026-09-08', null, 'missing'],
      ['2026-09-16', 3, 'partial'],
    ] as const)
      addObservation(
        series,
        { date, value, quality, provenance: 'test' },
        '2026-09-01',
        '2026-09-16',
      );
    expect(series.first).toMatchObject({ date: '2026-09-01', value: 0 });
    expect(series.last).toMatchObject({ date: '2026-09-15', value: 8 });
    expect(series.change).toBe(8);
    expect(series.count).toBe(2);
    expect(series.incomplete_count).toBe(2);
  });

  it('does not compare a single observation or invent zero for missing data', () => {
    const series = createMetricSeries()[0];
    expect(series.first).toBeNull();
    expect(series.change).toBeNull();
    addObservation(
      series,
      {
        date: '2026-01-01',
        value: 70,
        quality: 'complete',
        provenance: 'test',
      },
      '2026-09-01',
      '2026-09-16',
    );
    expect(series.change).toBeNull();
    expect(series.points).toEqual([]);
    expect(series.first?.value).toBe(70);
  });

  it.each(['hunger_level', 'energy_level', 'digestion_level'])(
    'validates optional %s for old/new apps',
    async (field) => {
      for (const value of [undefined, null, 1, 10]) {
        const dto = plainToInstance(CreateRecapDto, {
          week_start_date: '2026-09-07',
          week_end_date: '2026-09-13',
          [field]: value,
        });
        expect(
          await validate(dto, { whitelist: true, forbidNonWhitelisted: true }),
        ).toHaveLength(0);
      }
      for (const value of [0, 11, 1.5, '5']) {
        const dto = plainToInstance(UpdateRecapDto, { [field]: value });
        expect(
          (await validate(dto)).some((error) => error.property === field),
        ).toBe(true);
      }
    },
  );

  it.each(['2026-02-30', 'bad', '2026-01-01T00:00:00Z'])(
    'rejects invalid civil date %s',
    async (from) => {
      expect(
        await validate(plainToInstance(MetricsOverviewQueryDto, { from })),
      ).not.toHaveLength(0);
    },
  );
  it.each([0, -1, 1.5, 5001])('rejects invalid chart page %s', async (page) => {
    expect(
      await validate(plainToInstance(MetricsOverviewQueryDto, { page })),
    ).not.toHaveLength(0);
  });
});
