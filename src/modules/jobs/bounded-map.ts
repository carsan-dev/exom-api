export async function boundedMap<T, R>(
  items: readonly T[],
  map: (item: T) => Promise<R>,
  concurrency = 4,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new RangeError('Concurrency must be a positive integer');
  const result = new Array<R>(items.length);
  let index = 0;
  let failed = false;
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!failed && index < items.length) {
        const current = index++;
        try {
          result[current] = await map(items[current]);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  for (const worker of workers)
    if (worker.status === 'rejected') throw worker.reason;
  return result;
}
