import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { WeeklyRecap, DayProgress } from '@prisma/client';
import type { DietHistoryEntry } from '../../common/progress/diet-history';
import type { MetricsOverviewQueryDto } from './dto/metrics-overview-query.dto';
import {
  addObservation,
  BODY_METRICS,
  createMetricSeries,
  estimateMarkedNutrients,
  HABIT_METRICS,
} from './metric-observations';

const day = 86400000;
const civil = (date: Date) => date.toISOString().slice(0, 10);
const submitted = {
  in: ['SUBMITTED', 'REVIEWED'] as ('SUBMITTED' | 'REVIEWED')[],
};

export async function metricsOverview(
  db: Prisma.TransactionClient,
  clientId: string,
  query: MetricsOverviewQueryDto,
) {
  const today = civil(new Date());
  const to = query.to ?? today;
  if (to > today || (query.from && query.from > to))
    throw new BadRequestException('Periodo inválido o futuro');
  const [bodyStart, recapStart, progressStart] = await Promise.all([
    db.bodyMetric.aggregate({
      where: { client_id: clientId },
      _min: { date: true },
    }),
    db.weeklyRecap.aggregate({
      where: { client_id: clientId, status: submitted },
      _min: { week_start_date: true },
    }),
    db.dayProgress.aggregate({
      where: { client_id: clientId },
      _min: { date: true },
    }),
  ]);
  const starts = [
    bodyStart._min.date,
    recapStart._min.week_start_date,
    progressStart._min.date,
  ]
    .filter((date): date is Date => date !== null)
    .map(civil)
    .sort();
  const from = query.from ?? (starts[0] && starts[0] < to ? starts[0] : to);
  const start = new Date(from);
  const end = new Date(to);
  const totalPages = Math.max(
    1,
    Math.ceil(((end.getTime() - start.getTime()) / day + 1) / 90),
  );
  const page = query.page ?? 1;
  if (page > totalPages)
    throw new BadRequestException('Página fuera del periodo');
  const chartTo = civil(new Date(end.getTime() - (page - 1) * 90 * day));
  const chartFrom = civil(
    new Date(Math.max(start.getTime(), new Date(chartTo).getTime() - 89 * day)),
  );
  const series = createMetricSeries();
  const byKey = new Map(series.map((item) => [item.key, item]));

  // Read bounded batches under one repeatable-read snapshot. Only summary extrema
  // and the selected 90-day chart window remain in memory, including "since start".
  let after: Date | undefined;
  while (true) {
    const rows = await db.bodyMetric.findMany({
      where: {
        client_id: clientId,
        date: { gte: start, lte: end, ...(after ? { gt: after } : {}) },
      },
      orderBy: { date: 'asc' },
      take: 250,
    });
    for (const row of rows) {
      for (const [field] of BODY_METRICS) {
        const value = row[field];
        if (value == null || !Number.isFinite(value) || value < 0) continue;
        addObservation(
          byKey.get(field)!,
          {
            date: civil(row.date),
            value,
            quality: 'complete',
            provenance: 'body_metric',
          },
          chartFrom,
          chartTo,
        );
      }
    }
    if (rows.length < 250) break;
    after = rows[rows.length - 1].date;
  }
  after = undefined;
  while (true) {
    const rows: Pick<
      WeeklyRecap,
      | 'week_start_date'
      | 'week_end_date'
      | 'average_daily_steps'
      | 'stress_enabled'
      | 'stress_level'
      | 'hunger_level'
      | 'energy_level'
      | 'digestion_level'
    >[] = await db.weeklyRecap.findMany({
      where: {
        client_id: clientId,
        status: submitted,
        week_start_date: {
          gte: start,
          lte: end,
          ...(after ? { gt: after } : {}),
        },
      },
      orderBy: { week_start_date: 'asc' },
      take: 250,
      select: {
        week_start_date: true,
        week_end_date: true,
        average_daily_steps: true,
        stress_enabled: true,
        stress_level: true,
        hunger_level: true,
        energy_level: true,
        digestion_level: true,
      },
    });
    for (const row of rows) {
      for (const [field] of HABIT_METRICS) {
        const value = row[field];
        if (value == null || (field === 'stress_level' && !row.stress_enabled))
          continue;
        addObservation(
          byKey.get(field)!,
          {
            date: civil(row.week_start_date),
            end_date: civil(row.week_end_date),
            value,
            quality: 'complete',
            provenance: 'weekly_recap',
          },
          chartFrom,
          chartTo,
        );
      }
    }
    if (rows.length < 250) break;
    after = rows[rows.length - 1].week_start_date;
  }
  after = undefined;
  while (true) {
    const rows: Pick<DayProgress, 'date' | 'meals_completed'>[] =
      await db.dayProgress.findMany({
        where: {
          client_id: clientId,
          date: { gte: start, lte: end, ...(after ? { gt: after } : {}) },
        },
        orderBy: { date: 'asc' },
        take: 100,
        select: { date: true, meals_completed: true },
      });
    if (!rows.length) break;
    const history = await db.$queryRaw<DietHistoryEntry[]>(Prisma.sql`
      SELECT client_id, date, diet_id, version, provenance, captured_at, diet
      FROM diet_day_snapshots WHERE client_id = ${clientId}
      AND date IN (${Prisma.join(rows.map((row) => row.date))}) ORDER BY date, diet_id
    `);
    const byDate = new Map<string, DietHistoryEntry[]>();
    for (const entry of history) {
      const key = civil(entry.date);
      const entries = byDate.get(key) ?? [];
      entries.push(entry);
      byDate.set(key, entries);
    }
    for (const row of rows) {
      const date = civil(row.date);
      const entries = byDate.get(date) ?? [];
      // A progress row without any meal data or diet history is not a food log.
      if (!row.meals_completed.length && !entries.length) continue;
      for (const point of estimateMarkedNutrients(
        row.meals_completed,
        entries,
      )) {
        addObservation(
          byKey.get(point.key)!,
          {
            date,
            value: point.value,
            quality: point.quality,
            provenance: point.provenance,
          },
          chartFrom,
          chartTo,
        );
      }
    }
    if (rows.length < 100) break;
    after = rows[rows.length - 1].date;
  }
  return {
    client_id: clientId,
    from,
    to,
    chart_from: chartFrom,
    chart_to: chartTo,
    page,
    total_pages: totalPages,
    weekly_period_rule: 'week_start_in_period',
    series: series.filter(
      (item) => item.key !== 'muscle_mass_kg' || item.count > 0,
    ),
  };
}
