import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Equals } from 'class-validator';
import { Role } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { ClientDeletionService } from './client-deletion.service';

export class DeleteClientDto {
  @ApiProperty({ enum: ['ELIMINAR'] })
  @Equals('ELIMINAR')
  confirmation: string;
}

@ApiTags('Admin - Client deletion')
@ApiBearerAuth()
@Roles(Role.SUPER_ADMIN)
@Controller('admin')
export class ClientDeletionController {
  constructor(private readonly deletion: ClientDeletionService) {}

  @Delete('clients/:id')
  @HttpCode(202)
  request(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() _dto: DeleteClientDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.deletion.request(id, user.id);
  }

  @Get('client-deletions')
  list() {
    return this.deletion.list();
  }

  @Get('client-deletions/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.deletion.get(id);
  }
}
