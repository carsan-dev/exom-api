import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateAchievementDto } from './create-achievement.dto';

describe('CreateAchievementDto', () => {
  it('rejects blank name and description after trimming', async () => {
    const dto = plainToInstance(CreateAchievementDto, {
      name: '   ',
      description: '    ',
      criteria_type: 'CUSTOM',
      criteria_value: 1,
    });

    const errors = await validate(dto);
    const properties = errors.map((error) => error.property);

    expect(properties).toEqual(
      expect.arrayContaining(['name', 'description']),
    );
  });

  it('trims valid string fields before validation', async () => {
    const dto = plainToInstance(CreateAchievementDto, {
      name: '  Primer logro  ',
      description: '   Logro válido para pruebas   ',
      icon_url: '  https://example.com/icon.png  ',
      criteria_type: 'CUSTOM',
      criteria_value: 1,
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.name).toBe('Primer logro');
    expect(dto.description).toBe('Logro válido para pruebas');
    expect(dto.icon_url).toBe('https://example.com/icon.png');
  });
});
