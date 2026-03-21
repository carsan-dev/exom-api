import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
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
}
