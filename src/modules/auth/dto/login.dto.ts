import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsNotEmpty, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'cliente@exom.app' })
  @IsEmail()
  email: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  password: string;
}

export class SocialLoginDto {
  @ApiProperty({ description: 'Firebase ID token from Google/Apple Sign-In' })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiProperty({ enum: ['google', 'apple'] })
  @IsEnum(['google', 'apple'])
  provider: 'google' | 'apple';
}

export class ForgotPasswordDto {
  @ApiProperty()
  @IsEmail()
  email: string;
}

export class RefreshTokenDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  refresh_token: string;
}
