const mockBootstrap = jest.fn();
jest.mock('dotenv/config', () => ({}));
jest.mock('./bootstrap', () => ({ bootstrap: mockBootstrap }));

describe('startup process entry point', () => {
  const originalExitCode = process.exitCode;
  afterEach(() => {
    process.exitCode = originalExitCode;
    jest.restoreAllMocks();
  });
  it('prints a safe diagnostic and sets exit status 1 on failure', async () => {
    mockBootstrap.mockRejectedValueOnce({
      code: '28P01',
      message: 'postgresql://fixture:synthetic-secret@private/db',
    });
    const log = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    jest.isolateModules(() => {
      jest.requireActual('./main');
    });
    await Promise.resolve();
    expect(log.mock.calls).toEqual([
      [
        'API startup failed [dependencies/28P01]. Check database credentials in DATABASE_URL.',
      ],
    ]);
    expect(process.exitCode).toBe(1);
  });
  it('does not mark a successful startup as failed', async () => {
    mockBootstrap.mockResolvedValueOnce(undefined);
    const log = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    jest.isolateModules(() => {
      jest.requireActual('./main');
    });
    await Promise.resolve();
    expect(log).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(originalExitCode);
  });
});
