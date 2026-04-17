import {
  Controller,
  Delete,
  Get,
  Put,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { ProfileService } from './profile.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Profile')
@ApiBearerAuth()
@Controller('profile')
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get my profile' })
  getMyProfile(@CurrentUser() user: AuthenticatedUser) {
    return this.profileService.getMyProfile(user.id);
  }

  @Put('me')
  @ApiOperation({ summary: 'Update my profile' })
  updateMyProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.profileService.updateMyProfile(user.id, dto);
  }

  @Put('me/avatar')
  @ApiOperation({ summary: 'Get presigned URL for avatar upload' })
  @HttpCode(HttpStatus.OK)
  getAvatarUploadUrl(@CurrentUser() user: AuthenticatedUser) {
    return this.profileService.getAvatarUploadUrl(user.id);
  }

  @Delete('me')
  @ApiOperation({ summary: 'Eliminar mi cuenta y todos los datos asociados' })
  @ApiResponse({ status: 200, description: 'Cuenta eliminada correctamente' })
  @ApiResponse({ status: 404, description: 'Usuario no encontrado' })
  @HttpCode(HttpStatus.OK)
  deleteMyAccount(@CurrentUser() user: AuthenticatedUser) {
    return this.profileService.deleteMyAccount(user.id);
  }
}
