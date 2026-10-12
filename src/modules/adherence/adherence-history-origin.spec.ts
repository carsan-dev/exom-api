import { EventEmitter } from 'node:events';
import { activateAdherenceHistoryOrigin } from './adherence-history-origin';

class Backend extends EventEmitter {
  readonly statements: string[] = [];
  readonly release = jest.fn();
  pid = 7;
  failCommit = false;
  failActivation = false;
  query(text: string, values?: unknown[]) {
    this.statements.push(text);
    if (text === 'COMMIT' && this.failCommit)
      return Promise.reject(new Error('ACK lost'));
    if (text.includes('activate_adherence_history_origin')) {
      if (this.failActivation) return Promise.reject(new Error('lock timeout'));
      return Promise.resolve({
        rows: [{ id: 'fresh', activating_full_xid: '100' }],
      });
    }
    if (text.includes('backend_start'))
      return Promise.resolve({
        rows: [{ pid: this.pid, started: 'generation' }],
      });
    return Promise.resolve({ rows: [{ value: values?.[0] }] });
  }
}
const request = (origin: string) => ({
  origin,
  epochId: 'fresh',
  fullXid: '100',
  cutoffUtc: '2099-01-01T00:00:00.000000Z',
});

describe('live process-local origin lease', () => {
  it('activates before minting and binds only fresh epoch/XIDs', async () => {
    const backend = new Backend();
    const lease = await activateAdherenceHistoryOrigin(backend);
    expect(backend.statements.at(-1)).toBe('COMMIT');
    expect(lease.epochId).toBe('fresh');
    await lease.withSession(async (session) => {
      expect(await session.verifyOrigin(request(lease.origin))).toBe(
        lease.origin,
      );
      expect(
        await session.verifyOrigin({
          ...request(lease.origin),
          epochId: 'old',
        }),
      ).toBeUndefined();
      expect(
        await session.verifyOrigin({ ...request(lease.origin), fullXid: '99' }),
      ).toBeUndefined();
      expect(await session.sql.$queryRaw`SELECT ${'bound'}`).toEqual([
        { value: 'bound' },
      ]);
    });
    await lease.close();
    await expect(lease.withSession(() => Promise.resolve(1))).rejects.toThrow();
    expect(backend.release).toHaveBeenCalledTimes(1);
  });
  it.each(['activation', 'commit'])(
    'cannot mint on %s failure and rolls back',
    async (failure) => {
      const backend = new Backend();
      backend.failActivation = failure === 'activation';
      backend.failCommit = failure === 'commit';
      await expect(activateAdherenceHistoryOrigin(backend)).rejects.toThrow();
      expect(backend.statements).toContain('ROLLBACK');
      expect(backend.release).toHaveBeenCalledTimes(1);
    },
  );
  it('serializes callbacks and holds the lease through COMMIT', async () => {
    const backend = new Backend();
    const lease = await activateAdherenceHistoryOrigin(backend);
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const order: string[] = [];
    const first = lease.withSession(async () => {
      order.push('first');
      await gate;
    });
    const second = lease.withSession(() => {
      order.push('second');
      return Promise.resolve();
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['first']);
    unblock();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
    await lease.close();
  });
  it.each(['error', 'end', 'pid', 'commit'])(
    'permanently revokes on %s, never rebinds',
    async (failure) => {
      const backend = new Backend();
      const lease = await activateAdherenceHistoryOrigin(backend);
      await expect(
        lease.withSession(() => {
          if (failure === 'pid') backend.pid++;
          else if (failure === 'commit') backend.failCommit = true;
          else backend.emit(failure, new Error('transport lost'));
          return Promise.resolve();
        }),
      ).rejects.toThrow();
      const count = backend.statements.length;
      await expect(
        lease.withSession(() => Promise.resolve(1)),
      ).rejects.toThrow();
      expect(backend.statements).toHaveLength(count);
      expect(backend.statements).toContain('ROLLBACK');
      await lease.close();
    },
  );
});
