import {
  Body,
  Controller,
  Get,
  Headers,
  Patch,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { MobileAppConfigResponseDto } from './dto/mobile-app-config-response.dto';
import { UpdateMobileReleaseDto } from './dto/update-mobile-release.dto';
import { PublicConfigService } from './public-config.service';

@ApiTags('Public Config')
@Controller('public')
export class PublicConfigController {
  constructor(private readonly publicConfigService: PublicConfigService) {}

  @Public()
  @Get('healthchk')
  @ApiOperation({ summary: 'Health check' })
  @ApiResponse({ status: 200, description: 'OK' })
  health() {
    return { status: 'ok' };
  }

  @Public()
  @Get('mobile-config')
  @ApiOperation({
    summary: 'Obtener configuracion publica de distribucion movil',
  })
  @ApiResponse({
    status: 200,
    description: 'Configuracion publica de distribucion movil',
    type: MobileAppConfigResponseDto,
  })
  getMobileConfig(): Promise<MobileAppConfigResponseDto> {
    return this.publicConfigService.getMobileAppConfig();
  }

  @Public()
  @Patch('mobile-config/release')
  @ApiHeader({ name: 'x-mobile-config-token', required: true })
  @ApiOperation({
    summary: 'Actualizar configuracion movil desde CI',
  })
  @ApiResponse({
    status: 200,
    description: 'Configuracion movil actualizada',
    type: MobileAppConfigResponseDto,
  })
  updateMobileRelease(
    @Body() dto: UpdateMobileReleaseDto,
    @Headers('x-mobile-config-token') token: string | undefined,
  ): Promise<MobileAppConfigResponseDto> {
    const expectedToken = process.env.MOBILE_CONFIG_UPDATE_TOKEN;
    if (!expectedToken || token !== expectedToken) {
      throw new UnauthorizedException('Token de configuracion movil invalido');
    }

    return this.publicConfigService.updateMobileRelease(dto);
  }
}
