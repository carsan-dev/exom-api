import { BadRequestException } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import {
  IsOptional,
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';
import { IsDateOnly, isDateOnly, parseDateOnly } from '../date-only';

const DAY_MS = 86_400_000;
// Keeps the exclusive next-midnight bound within PostgreSQL timestamp range.
export const STATS_PERIOD_MIN_YEAR = 2000;
export const STATS_PERIOD_MAX_YEAR = 2100;

function isStatsPeriodYear(value: string): boolean {
  const year = Number(value.slice(0, 4));
  return year >= STATS_PERIOD_MIN_YEAR && year <= STATS_PERIOD_MAX_YEAR;
}

function IsStatsPeriodYear(options?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'isStatsPeriodYear',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        // Malformed dates are reported by IsDateOnly.
        validate: (value: unknown) =>
          !isDateOnly(value) || isStatsPeriodYear(value),
        defaultMessage: (args: ValidationArguments) =>
          `${args.property} debe estar entre los años ${STATS_PERIOD_MIN_YEAR} y ${STATS_PERIOD_MAX_YEAR}`,
      },
    });
  };
}

function parseStatsPeriodDate(value: string, field: string): Date {
  const date = parseDateOnly(value, field);
  if (!isStatsPeriodYear(value))
    throw new BadRequestException({
      code: 'INVALID_DATE',
      message: `${field} debe estar entre los años ${STATS_PERIOD_MIN_YEAR} y ${STATS_PERIOD_MAX_YEAR}`,
    });
  return date;
}

/** Lower bound inclusive, upper bound exclusive, both at UTC midnight. */
export interface StatsPeriod {
  gte?: Date;
  lt?: Date;
}

function IsNotBeforeField(field: string, options?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'isNotBeforeField',
      target: object.constructor,
      propertyName,
      constraints: [field],
      options,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const [related] = args.constraints as [string];
          const other = (args.object as Record<string, unknown>)[related];
          // Invalid or missing bounds are reported by their own validators.
          if (!isDateOnly(value) || !isDateOnly(other)) return true;
          return other <= value;
        },
        defaultMessage: (args: ValidationArguments) =>
          `${args.property} debe ser igual o posterior a ${String(args.constraints[0])}`,
      },
    });
  };
}

export class StatsPeriodQueryDto {
  @ApiPropertyOptional({
    description: 'Inclusive UTC civil start date (YYYY-MM-DD)',
    example: '2026-10-01',
  })
  @IsOptional()
  @IsDateOnly()
  @IsStatsPeriodYear()
  from?: string;

  @ApiPropertyOptional({
    description:
      'Inclusive UTC civil end date (YYYY-MM-DD); covers the whole day',
    example: '2026-10-31',
  })
  @IsOptional()
  @IsDateOnly()
  @IsStatsPeriodYear()
  @IsNotBeforeField('from')
  to?: string;
}

export function resolveStatsPeriod(query: {
  from?: string;
  to?: string;
}): StatsPeriod | undefined {
  if (!query.from && !query.to) return undefined;
  const period: StatsPeriod = {};
  if (query.from) period.gte = parseStatsPeriodDate(query.from, 'from');
  if (query.to)
    period.lt = new Date(
      parseStatsPeriodDate(query.to, 'to').getTime() + DAY_MS,
    );
  return period;
}

export function statsPeriodDateFilter(
  period: StatsPeriod | undefined,
): Prisma.DateTimeFilter | undefined {
  if (!period) return undefined;
  return {
    ...(period.gte ? { gte: period.gte } : {}),
    ...(period.lt ? { lt: period.lt } : {}),
  };
}

// Columns are TIMESTAMP(3) without zone holding UTC; bind zone-free text so
// the comparison never depends on the session time zone.
function utcTimestampText(date: Date): string {
  return date.toISOString().replace('Z', '');
}

export function statsPeriodSql(
  column: Prisma.Sql,
  period: StatsPeriod | undefined,
): Prisma.Sql {
  if (!period) return Prisma.empty;
  const parts: Prisma.Sql[] = [];
  if (period.gte)
    parts.push(
      Prisma.sql`AND ${column} >= ${utcTimestampText(period.gte)}::timestamp`,
    );
  if (period.lt)
    parts.push(
      Prisma.sql`AND ${column} < ${utcTimestampText(period.lt)}::timestamp`,
    );
  return Prisma.join(parts, ' ');
}
