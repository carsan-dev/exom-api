import { Module } from '@nestjs/common';
import { ChallengesModule } from '../challenges/challenges.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [ChallengesModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
