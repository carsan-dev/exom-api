const mockApp = {
  enableShutdownHooks: jest.fn(),
  listen: jest.fn(),
  close: jest.fn(),
};
const mockCreate = jest.fn(() => Promise.resolve(mockApp));
jest.mock('@nestjs/core', () => ({
  NestFactory: { create: mockCreate },
}));
jest.mock('./app.module', () => ({ AppModule: class {} }));
jest.mock('./configure-app', () => ({ configureApp: jest.fn() }));
jest.mock('./config/firebase.config', () => ({ initFirebase: jest.fn() }));

import { initFirebase } from './config/firebase.config';
import { configureApp } from './configure-app';
import { bootstrap } from './bootstrap';
import { StartupError } from './startup-error';

describe('startup lifecycle diagnostics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApp.listen.mockResolvedValue(undefined);
    mockApp.close.mockResolvedValue(undefined);
  });
  afterEach(() => jest.restoreAllMocks());
  it('starts normally without closing the application', async () => {
    await bootstrap();
    expect(initFirebase).toHaveBeenCalledTimes(1);
    expect(configureApp).toHaveBeenCalledWith(mockApp);
    expect(mockApp.enableShutdownHooks).toHaveBeenCalledTimes(1);
    expect(mockApp.listen).toHaveBeenCalledWith(process.env.PORT ?? 3000);
    expect(mockApp.close).not.toHaveBeenCalled();
  });
  it('preserves the original database failure when app cleanup also fails', async () => {
    const failure = new StartupError('database', {
      code: 'SELF_SIGNED_CERT_IN_CHAIN',
    });
    mockApp.listen.mockRejectedValueOnce(failure);
    mockApp.close.mockRejectedValueOnce(new Error('synthetic-cleanup-secret'));
    const log = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    await expect(bootstrap()).rejects.toBe(failure);
    expect(mockApp.close).toHaveBeenCalledTimes(1);
    expect(log.mock.calls).toEqual([
      ['API startup cleanup failed; original failure preserved'],
    ]);
  });
  it('identifies port errors without printing the raw error', async () => {
    mockApp.listen.mockRejectedValueOnce({
      code: 'EADDRINUSE',
      message: 'synthetic-secret',
    });
    await expect(bootstrap()).rejects.toThrow('[listen/EADDRINUSE]');
    expect(mockApp.close).toHaveBeenCalledTimes(1);
  });
  it('identifies Firebase failure before Nest is created', async () => {
    jest.mocked(initFirebase).mockImplementationOnce(() => {
      throw new Error('synthetic-secret');
    });
    await expect(bootstrap()).rejects.toThrow('[firebase/UNKNOWN]');
    expect(mockCreate).not.toHaveBeenCalled();
  });
  it('identifies dependency creation failure', async () => {
    mockCreate.mockRejectedValueOnce(new Error('synthetic-secret'));
    await expect(bootstrap()).rejects.toThrow('[dependencies/UNKNOWN]');
    expect(mockApp.close).not.toHaveBeenCalled();
  });
  it('identifies application configuration failure and closes resources', async () => {
    jest.mocked(configureApp).mockImplementationOnce(() => {
      throw new Error('synthetic-secret');
    });
    await expect(bootstrap()).rejects.toThrow('[configuration/UNKNOWN]');
    expect(mockApp.close).toHaveBeenCalledTimes(1);
  });
});
