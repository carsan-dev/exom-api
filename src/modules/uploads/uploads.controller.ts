import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { UploadsService } from './uploads.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '@prisma/client';

class GetPresignedUrlDto {
  @ApiProperty()
  @IsString()
  file_key: string;

  @ApiProperty()
  @IsString()
  content_type: string;
}

@ApiTags('Uploads')
@ApiBearerAuth()
@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post('presigned')
  @ApiOperation({ summary: 'Get a presigned URL for file upload to R2' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.CLIENT)
  @HttpCode(HttpStatus.OK)
  getPresignedUrl(@Body() body: GetPresignedUrlDto) {
    return this.uploadsService.getPresignedUrl(
      body.file_key,
      body.content_type,
    );
  }

  @Post('file')
  @ApiOperation({ summary: 'Upload a file to R2 via backend proxy' })
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.CLIENT)
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
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 100 * 1024 * 1024 } }))
  uploadFile(
    @UploadedFile() file: Express.Multer.File,
    @Body('file_key') fileKey: string,
    @Body('content_type') contentType: string,
  ) {
    if (!file) throw new BadRequestException('file is required');
    if (!fileKey) throw new BadRequestException('file_key is required');
    if (!contentType) throw new BadRequestException('content_type is required');

    return this.uploadsService.uploadFile(file.buffer, fileKey, contentType);
  }
}
