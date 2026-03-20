import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { ProfileModule } from './modules/profile/profile.module';
import { TrainingsModule } from './modules/trainings/trainings.module';
import { ExercisesModule } from './modules/exercises/exercises.module';
import { DietsModule } from './modules/diets/diets.module';
import { MealsModule } from './modules/meals/meals.module';
import { IngredientsModule } from './modules/ingredients/ingredients.module';
import { AssignmentsModule } from './modules/assignments/assignments.module';
import { ProgressModule } from './modules/progress/progress.module';
import { CalendarModule } from './modules/calendar/calendar.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { RecapsModule } from './modules/recaps/recaps.module';
import { ChallengesModule } from './modules/challenges/challenges.module';
import { AchievementsModule } from './modules/achievements/achievements.module';
import { StreaksModule } from './modules/streaks/streaks.module';
import { FeedbackModule } from './modules/feedback/feedback.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { NotificationsModule } from './modules/notifications/notifications.module';

@Module({
  imports: [AuthModule, UsersModule, ProfileModule, TrainingsModule, ExercisesModule, DietsModule, MealsModule, IngredientsModule, AssignmentsModule, ProgressModule, CalendarModule, MetricsModule, RecapsModule, ChallengesModule, AchievementsModule, StreaksModule, FeedbackModule, UploadsModule, NotificationsModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
