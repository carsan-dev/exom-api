import { ApiProperty } from '@nestjs/swagger';

class ClientAssignmentAdminProfileDto {
  @ApiProperty({ nullable: true })
  first_name: string | null;

  @ApiProperty({ nullable: true })
  last_name: string | null;

  @ApiProperty({ nullable: true })
  avatar_url: string | null;
}

class ClientAssignmentAdminDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  email: string;

  @ApiProperty({ type: ClientAssignmentAdminProfileDto, nullable: true })
  profile: ClientAssignmentAdminProfileDto | null;

  @ApiProperty({ type: String, format: 'date-time' })
  assigned_at: Date;
}

export class ClientAssignmentResponseDto {
  @ApiProperty()
  client_id: string;

  @ApiProperty({ type: [ClientAssignmentAdminDto] })
  active_admins: ClientAssignmentAdminDto[];
}
