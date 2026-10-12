import { BadRequestException } from '@nestjs/common';
import { IsString, Matches } from 'class-validator';

export class AdherencePeriodQueryDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  start!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  end!: string;

  static dates(start: string, end: string): string[] {
    const civil = (value: string) => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
        throw new BadRequestException('Expected UTC civil dates');
      const date = new Date(`${value}T00:00:00.000Z`);
      if (
        !Number.isFinite(date.getTime()) ||
        date.toISOString().slice(0, 10) !== value
      )
        throw new BadRequestException('Invalid UTC civil date');
      return date.getTime();
    };
    const first = civil(start);
    const last = civil(end);
    const count = (last - first) / 86_400_000 + 1;
    if (count < 1 || count > 31)
      throw new BadRequestException('Period must contain 1 to 31 days');
    return Array.from({ length: count }, (_, i) =>
      new Date(first + i * 86_400_000).toISOString().slice(0, 10),
    );
  }
}
