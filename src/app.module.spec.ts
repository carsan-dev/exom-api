import type { DynamicModule } from '@nestjs/common';

describe('AppModule scheduler registration', () => {
  const originalEnvironment = {
    NODE_ENV: process.env.NODE_ENV,
    HOST: process.env.HOST,
    EXOM_SMOKE_DISABLE_SCHEDULERS: process.env.EXOM_SMOKE_DISABLE_SCHEDULERS,
  };

  afterAll(() => {
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it.each([
    {
      name: 'isolated test smoke with explicit opt-in',
      nodeEnv: 'test',
      host: '127.0.0.1',
      optIn: '1',
      enabled: false,
    },
    {
      name: 'test without opt-in',
      nodeEnv: 'test',
      host: '127.0.0.1',
      optIn: undefined,
      enabled: true,
    },
    {
      name: 'test with a different host',
      nodeEnv: 'test',
      host: '0.0.0.0',
      optIn: '1',
      enabled: true,
    },
    {
      name: 'test with a different opt-in value',
      nodeEnv: 'test',
      host: '127.0.0.1',
      optIn: 'true',
      enabled: true,
    },
    {
      name: 'production even with smoke opt-in',
      nodeEnv: 'production',
      host: '127.0.0.1',
      optIn: '1',
      enabled: true,
    },
  ])('$name', ({ nodeEnv, host, optIn, enabled }) => {
    process.env.NODE_ENV = nodeEnv;
    process.env.HOST = host;
    if (optIn === undefined) {
      delete process.env.EXOM_SMOKE_DISABLE_SCHEDULERS;
    } else {
      process.env.EXOM_SMOKE_DISABLE_SCHEDULERS = optIn;
    }

    jest.isolateModules(() => {
      const { AppModule } =
        jest.requireActual<typeof import('./app.module')>('./app.module');
      const imports = Reflect.getMetadata('imports', AppModule) as unknown[];
      const schedule = imports.find(
        (entry): entry is DynamicModule =>
          typeof entry === 'object' &&
          entry !== null &&
          'module' in entry &&
          typeof entry.module === 'function' &&
          entry.module.name === 'ScheduleModule',
      );
      expect(schedule).toBeDefined();
      expect(schedule?.global).toBe(true);
      expect(
        schedule?.exports?.some(
          (entry) =>
            typeof entry === 'function' && entry.name === 'SchedulerRegistry',
        ),
      ).toBe(true);
      expect(schedule?.providers).toContainEqual({
        provide: 'SCHEDULE_MODULE_OPTIONS',
        useValue: {
          cronJobs: enabled,
          intervals: enabled,
          timeouts: enabled,
        },
      });
    });
  });
});
