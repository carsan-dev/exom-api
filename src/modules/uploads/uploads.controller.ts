import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { ManagedUploadPurpose, Role } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { UploadsService } from './uploads.service';

class CreateUploadSessionDto {
  @ApiProperty({ enum: ManagedUploadPurpose })
  @IsEnum(ManagedUploadPurpose)
  purpose: ManagedUploadPurpose;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  content_type: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  bytes: number;
}

class LegacyPresignedDto {
  @ApiProperty()
  @IsString()
  file_key: string;

  @ApiProperty()
  @IsString()
  content_type: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  bytes?: number;
}

const legacyUploadTempDir = path.join(os.tmpdir(), 'exom-legacy-uploads');

@ApiTags('Uploads')
@ApiBearerAuth()
@Controller('uploads')
@Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.CLIENT)
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post('sessions')
  @ApiOperation({ summary: 'Create a managed upload session' })
  createSession(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateUploadSessionDto,
  ) {
    return this.uploadsService.createSession(user.id, user.role, {
      purpose: body.purpose,
      mimeType: body.content_type,
      bytes: body.bytes,
    });
  }

  @Post('sessions/:id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify a managed upload against object metadata and signature',
  })
  completeSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.uploadsService.completeSession(user.id, id);
  }

  @Post('presigned')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Legacy compatible managed presigned upload' })
  getPresignedUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: LegacyPresignedDto,
  ) {
    return this.uploadsService.getLegacyPresignedUrl(
      user.id,
      user.role,
      body.file_key,
      body.content_type,
      body.bytes,
    );
  }

  @Post('file')
  @HttpCode(HttpStatus.OK)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'file_key', 'content_type'],
      properties: {
        file: { type: 'string', format: 'binary' },
        file_key: { type: 'string' },
        content_type: { type: 'string' },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_request, _file, callback) => {
          fs.mkdir(legacyUploadTempDir, { recursive: true }, (error) =>
            callback(error, legacyUploadTempDir),
          );
        },
        filename: (_request, _file, callback) =>
          callback(null, randomUUID()),
      }),
      limits: { fileSize: 250 * 1024 * 1024, files: 1 },
    }),
  )
  async uploadFile(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File,
    @Body('file_key') fileKey: string,
    @Body('content_type') contentType: string,
  ) {
    if (!file) throw new BadRequestException('file is required');
    if (!fileKey) throw new BadRequestException('file_key is required');
    if (!contentType) throw new BadRequestException('content_type is required');
    try {
      return await this.uploadsService.uploadLegacyFileFromPath(
        user.id,
        user.role,
        file.path,
        file.size,
        fileKey,
        contentType,
      );
    } finally {
      await fs.promises.unlink(file.path).catch(() => undefined);
    }
  }
}
