import { boundedMap } from './bounded-map';

it('P6-01/03 ISSUE-058: failure waits for in-flight tasks and stops claiming new recipients', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started: number[] = [];
  let settled = false;
  const result = boundedMap(
    [0, 1, 2, 3],
    async (item) => {
      started.push(item);
      if (item === 0) throw new Error('recipient failed');
      await blocked;
      return item;
    },
    2,
  ).finally(() => {
    settled = true;
  });
  const assertion = expect(result).rejects.toThrow('recipient failed');
  await new Promise<void>((resolve) => setImmediate(resolve));
  const prematurelySettled = settled;
  release();
  await assertion;
  expect(prematurelySettled).toBe(false);
  expect(started).toEqual([0, 1]);
});

it('rejects an invalid concurrency instead of silently dropping the audience', async () => {
  await expect(
    boundedMap([1], (item) => Promise.resolve(item), 0),
  ).rejects.toThrow(RangeError);
});
