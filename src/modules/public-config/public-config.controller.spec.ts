import { UnauthorizedException } from '@nestjs/common';
import { PublicConfigController } from './public-config.controller';
import { PublicConfigService } from './public-config.service';

describe('PublicConfigController', () => {
  let controller: PublicConfigController;
  let service: {
    getMobileAppConfig: jest.Mock;
    updateMobileRelease: jest.Mock;
  };

  beforeEach(() => {
    service = {
      getMobileAppConfig: jest.fn(),
      updateMobileRelease: jest.fn(),
    };
    controller = new PublicConfigController(
      service as unknown as PublicConfigService,
    );
    process.env.MOBILE_CONFIG_UPDATE_TOKEN = 'ci-token';
  });

  afterEach(() => {
    delete process.env.MOBILE_CONFIG_UPDATE_TOKEN;
  });

  it('rejects release updates without the configured CI token', () => {
    expect(() =>
      controller.updateMobileRelease(
        {
          platform: 'android',
          version: '1.0.1',
          build: 66,
          policy: 'recommended',
        },
        'bad-token',
      ),
    ).toThrow(
      new UnauthorizedException('Token de configuracion movil invalido'),
    );
  });

  it('passes valid release updates to the service', async () => {
    const dto = {
      platform: 'ios' as const,
      version: '1.0.1',
      build: 59,
      policy: 'blocking' as const,
    };
    service.updateMobileRelease.mockResolvedValue({ latest_ios_version: '1.0.1' });

    await controller.updateMobileRelease(dto, 'ci-token');

    expect(service.updateMobileRelease).toHaveBeenCalledWith(dto);
  });
});
