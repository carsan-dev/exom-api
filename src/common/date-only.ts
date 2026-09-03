import { BadRequestException } from '@nestjs/common';
import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function isDateOnly(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) return false;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return !Number.isNaN(date.getTime()) && formatDateOnly(date) === value;
}

export function parseDateOnly(value: string, field = 'date'): Date {
  if (!isDateOnly(value)) {
    throw new BadRequestException({
      code: 'INVALID_DATE',
      message: `${field} debe tener formato YYYY-MM-DD y ser una fecha válida`,
    });
  }

  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function IsDateOnly(validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'isDateOnly',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate: (value: unknown) => isDateOnly(value),
        defaultMessage: (args: ValidationArguments) =>
          `${args.property} debe tener formato YYYY-MM-DD y ser una fecha válida`,
      },
    });
  };
}
