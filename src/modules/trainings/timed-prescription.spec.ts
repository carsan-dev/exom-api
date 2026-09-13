import {
  resolveTimedPrescription,
  timedInstructions,
  validateTimedConfig,
} from './timed-prescription';

const config = {
  version: 1,
  unit: 'MINUTES',
  segments: [
    { action: 'Corre', seconds: 120, unit: 'MINUTES' },
    { action: 'Camina', seconds: 60, unit: 'MINUTES' },
  ],
};
describe('F007 temporal contract', () => {
  it('keeps total separate from ordered actions and rest', () => {
    const value = validateTimedConfig(config);
    expect(timedInstructions(1440, value)).toBe(
      '24 min en total. Corre: 2 min; Camina: 1 min; repetir hasta terminar.',
    );
    expect(timedInstructions(1500, value)).toContain(
      'Último tramo recortado: Corre, 1 min.',
    );
  });
  it.each([0, -1, 0.5, 2147483648])(
    'rejects invalid segment seconds %s',
    (seconds) => {
      expect(() =>
        validateTimedConfig({
          ...config,
          segments: [{ action: 'Corre', seconds, unit: 'SECONDS' }],
        }),
      ).toThrow();
    },
  );
  it('preserves omitted configuration and supports explicit removal', () => {
    const p = {
      measure_type: 'SECONDS',
      target_value: 1440,
      target_value_min: null,
      target_value_max: null,
      reps_or_duration: '1440s',
    };
    expect(resolveTimedPrescription({}, p, { timed_config: config })).toEqual(
      config,
    );
    expect(
      resolveTimedPrescription({ timed_config: null }, p, {
        timed_config: config,
      }),
    ).toBeNull();
    expect(() =>
      resolveTimedPrescription(
        {},
        { ...p, measure_type: 'REPS' },
        { timed_config: config },
      ),
    ).toThrow();
  });
  it('rejects unknown versions, fields, empty actions and excessive sequences', () => {
    for (const value of [
      { ...config, version: 2 },
      { ...config, total: 1440 },
      { ...config, segments: [{ action: ' ', seconds: 1, unit: 'SECONDS' }] },
      { ...config, segments: Array(21).fill(config.segments[0]) },
    ])
      expect(() => validateTimedConfig(value)).toThrow();
  });
});
