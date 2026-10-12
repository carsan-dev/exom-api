import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  AssociateProgressPhotoDto,
  CreateProgressPhotoSessionDto,
  ProgressPhotoHistoryQueryDto,
} from './dto/progress-photo.dto';
import { ProgressPhotosService } from './progress-photos.service';

@ApiTags('Progress photos')
@ApiBearerAuth()
@Controller('progress-photos')
export class ProgressPhotosController {
  constructor(private readonly progressPhotosService: ProgressPhotosService) {}

  @Get('sessions')
  @Roles(Role.CLIENT)
  @ApiOperation({ summary: 'Get the current client progress-photo history' })
  getOwnHistory(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ProgressPhotoHistoryQueryDto,
  ) {
    return this.progressPhotosService.getHistory(actor, actor.id, query);
  }

  @Get('sessions/:sessionId')
  @Roles(Role.CLIENT)
  @ApiOperation({ summary: 'Get a current client progress-photo session' })
  getOwnSession(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('sessionId') sessionId: string,
  ) {
    return this.progressPhotosService.getSession(actor, actor.id, sessionId);
  }

  @Post('sessions')
  @Roles(Role.CLIENT)
  @ApiOperation({
    summary: 'Create an incomplete dated progress-photo session',
  })
  @ApiResponse({ status: 409, description: 'Operation identity conflicts' })
  createOwnSession(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateProgressPhotoSessionDto,
  ) {
    return this.progressPhotosService.createSession(actor, actor.id, dto);
  }

  @Post('sessions/:sessionId/photos')
  @Roles(Role.CLIENT)
  @ApiOperation({
    summary:
      'Associate a verified progress-photo upload, or explicitly replace the active view photo',
  })
  @ApiResponse({
    status: 409,
    description: 'Conflict or replacement precondition failed',
  })
  associateOwnPhoto(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('sessionId') sessionId: string,
    @Body() dto: AssociateProgressPhotoDto,
  ) {
    return this.progressPhotosService.associatePhoto(
      actor,
      actor.id,
      sessionId,
      dto,
    );
  }

  @Get('photos/:photoId/file')
  @Roles(Role.CLIENT, Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Read an authorized local development progress-photo object',
  })
  async readPhotoFile(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('photoId') photoId: string,
  ) {
    const file = await this.progressPhotosService.readPhotoFile(actor, photoId);
    return new StreamableFile(file.data, { type: file.mimeType });
  }
}

@ApiTags('Admin - Progress photos')
@ApiBearerAuth()
@Controller('admin/clients/:clientId/progress-photos')
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
export class AdminProgressPhotosController {
  constructor(private readonly progressPhotosService: ProgressPhotosService) {}

  @Get('sessions')
  @ApiOperation({ summary: 'Get bounded progress-photo history for a client' })
  getHistory(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('clientId') clientId: string,
    @Query() query: ProgressPhotoHistoryQueryDto,
  ) {
    return this.progressPhotosService.getHistory(actor, clientId, query);
  }

  @Get('sessions/:sessionId')
  @ApiOperation({ summary: 'Get a client progress-photo session' })
  getSession(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('clientId') clientId: string,
    @Param('sessionId') sessionId: string,
  ) {
    return this.progressPhotosService.getSession(actor, clientId, sessionId);
  }

  @Post('sessions')
  @ApiOperation({ summary: 'Create an incomplete dated session for a client' })
  createSession(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('clientId') clientId: string,
    @Body() dto: CreateProgressPhotoSessionDto,
  ) {
    return this.progressPhotosService.createSession(actor, clientId, dto);
  }

  @Post('sessions/:sessionId/photos')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Associate an admin-owned verified upload or explicitly replace an active client photo',
  })
  associatePhoto(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('clientId') clientId: string,
    @Param('sessionId') sessionId: string,
    @Body() dto: AssociateProgressPhotoDto,
  ) {
    return this.progressPhotosService.associatePhoto(
      actor,
      clientId,
      sessionId,
      dto,
    );
  }
}
