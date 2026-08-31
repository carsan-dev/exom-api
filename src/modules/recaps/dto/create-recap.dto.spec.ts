import { validate } from 'class-validator';
import { CreateRecapDto } from './create-recap.dto';

function recapDto(averageDailySteps?: number) {
  return Object.assign(new CreateRecapDto(), {
    week_start_date: '2026-08-24',
    week_end_date: '2026-08-30',
    ...(averageDailySteps !== undefined
      ? { average_daily_steps: averageDailySteps }
      : {}),
  });
}

describe('CreateRecapDto average_daily_steps', () => {
  it.each([undefined, 0, 8500, 200000])('accepts %s', async (value) => {
    await expect(validate(recapDto(value))).resolves.toHaveLength(0);
  });

  it('accepts null so an existing value can be cleared', async () => {
    const dto = recapDto();
    dto.average_daily_steps = null;

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it.each([-1, 200001, 8500.5])('rejects %s', async (value) => {
    const errors = await validate(recapDto(value));

    expect(
      errors.some((error) => error.property === 'average_daily_steps'),
    ).toBe(true);
  });
});
