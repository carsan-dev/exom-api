import {
  monday,
  resolveRir,
  rirWeek,
  validateRirConfig,
  validateRirOverride,
  validateRirSequence,
} from './rir-cycle';
import { applyRirTargets } from '../../common/progress/rir-targets';

describe('RIR mesocycle calendar and contract', () => {
  it.each([[], [-1], [11], [1.5], ['3'], null, {}])(
    'rejects invalid sequence %p',
    (value) => expect(() => validateRirSequence(value)).toThrow(),
  );
  it('accepts single week and endpoints', () => {
    expect(validateRirSequence([0])).toEqual([0]);
    expect(validateRirSequence([10, 0])).toEqual([10, 0]);
  });
  it('uses Monday boundaries across years and repeats without sessions', () => {
    const start = new Date('2026-12-30Z');
    expect(monday(start).toISOString().slice(0, 10)).toBe('2026-12-28');
    expect(rirWeek(new Date('2027-01-03Z'), start, 4)).toBe(0);
    expect(rirWeek(new Date('2027-01-04Z'), start, 4)).toBe(1);
    expect(rirWeek(new Date('2027-01-25Z'), start, 4)).toBe(0);
    expect(rirWeek(new Date('2026-12-27Z'), start, 4)).toBeNull();
  });
  it('resolves each occurrence independently, including fixed zero and no objective', () => {
    const config = validateRirConfig({
      sequence: [3, 2],
      overrides: {
        a: { mode: 'FIXED', value: 0 },
        b: { mode: 'NONE' },
        c: { mode: 'SEQUENCE', sequence: [10, 1] },
        d: { mode: 'INHERIT' },
      },
    });
    const start = new Date('2026-09-09Z'),
      date = new Date('2026-09-14Z');
    expect(
      ['a', 'b', 'c', 'd', 'new'].map((id) =>
        resolveRir(config, start, date, id, 8),
      ),
    ).toEqual([0, null, 1, 2, 2]);
    expect(resolveRir(null, start, date, 'a', 8)).toBe(8);
    expect(() =>
      validateRirOverride({ mode: 'SEQUENCE', sequence: [1] }, 2),
    ).toThrow();
    expect(() =>
      validateRirConfig({
        sequence: [2],
        overrides: { a: { mode: 'FIXED', value: null } },
      }),
    ).toThrow();
  });
  it('projects null/zero consistently into flat and circuit occurrences', () => {
    const training = {
      exercises: [
        { id: 'a', target_rir: 7 },
        { id: 'b', target_rir: 7 },
      ],
      blocks: [{ exercises: [{ id: 'a', target_rir: 7 }] }],
    };
    const result = applyRirTargets(
      training,
      new Map([
        ['a', null],
        ['b', 0],
      ]),
    );
    expect(result.exercises.map((e) => e.target_rir)).toEqual([null, 0]);
    expect(result.blocks[0].exercises[0].target_rir).toBeNull();
    expect(training.exercises[0].target_rir).toBe(7);
  });
});
