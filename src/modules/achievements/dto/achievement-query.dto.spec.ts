import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RecomputeAchievementsDto } from './achievement-query.dto';

describe('RecomputeAchievementsDto', () => {
  it('requires user_ids or apply_to_all_visible_clients', async () => {
    const dto = plainToInstance(RecomputeAchievementsDto, {});

    const errors = await validate(dto);

    expect(errors.map((error) => error.property)).toContain(
      'apply_to_all_visible_clients',
    );
  });

  it('accepts explicit user_ids without the visible-scope flag', async () => {
    const dto = plainToInstance(RecomputeAchievementsDto, {
      user_ids: ['550e8400-e29b-41d4-a716-446655440000'],
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.apply_to_all_visible_clients).toBe(false);
  });

  it('accepts the visible-scope flag without user_ids', async () => {
    const dto = plainToInstance(RecomputeAchievementsDto, {
      apply_to_all_visible_clients: true,
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });
});
