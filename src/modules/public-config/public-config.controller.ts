import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { MobileAppConfigResponseDto } from './dto/mobile-app-config-response.dto';
import { PublicConfigService } from './public-config.service';

@ApiTags('Public Config')
@Controller('public')
export class PublicConfigController {
  constructor(private readonly publicConfigService: PublicConfigService) {}

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
  getMobileConfig(): MobileAppConfigResponseDto {
    return this.publicConfigService.getMobileAppConfig();
  }
}
