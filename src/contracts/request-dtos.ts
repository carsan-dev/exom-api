// Generated DTO metadata registry; regenerate with contract:update.
import { CreateCatalogGroupDto as D0 } from '../common/catalog-groups/dto/catalog-group.dto';
import { UpdateCatalogGroupDto as D1 } from '../common/catalog-groups/dto/catalog-group.dto';
import { UpdateTrainingGroupMembershipDto as D2 } from '../common/catalog-groups/dto/catalog-group.dto';
import { UpdateDietGroupMembershipDto as D3 } from '../common/catalog-groups/dto/catalog-group.dto';
import { CatalogValueWithColorDto as D4 } from '../common/dto/catalog-color.dto';
import { UpdateCatalogColorDto as D5 } from '../common/dto/catalog-color.dto';
import { CatalogColorMutationResponseDto as D6 } from '../common/dto/catalog-color.dto';
import { RenameCatalogValueDto as D7 } from '../common/dto/catalog-value.dto';
import { CatalogMutationResponseDto as D8 } from '../common/dto/catalog-value.dto';
import { DeleteCatalogValuesDto as D9 } from '../common/dto/catalog-value.dto';
import { CatalogBatchMutationResponseDto as D10 } from '../common/dto/catalog-value.dto';
import { PaginationDto as D11 } from '../common/dto/pagination.dto';
import { AchievementFiltersDto as D12 } from '../modules/achievements/dto/achievement-query.dto';
import { AchievementUsersQueryDto as D13 } from '../modules/achievements/dto/achievement-query.dto';
import { RevokeAchievementDto as D14 } from '../modules/achievements/dto/achievement-query.dto';
import { RecomputeAchievementsDto as D15 } from '../modules/achievements/dto/achievement-query.dto';
import { CreateAchievementDto as D16 } from '../modules/achievements/dto/create-achievement.dto';
import { GrantAchievementDto as D17 } from '../modules/achievements/dto/create-achievement.dto';
import { UpdateAchievementDto as D18 } from '../modules/achievements/dto/update-achievement.dto';
import { AdherenceConfigDateQueryDto as D19 } from '../modules/adherence/dto/adherence-config.dto';
import { UpdateAdherenceConfigDto as D20 } from '../modules/adherence/dto/adherence-config.dto';
import { AdherencePeriodQueryDto as D21 } from '../modules/adherence/dto/adherence-period-query.dto';
import { ApprovalRequestReasonDto as D22 } from '../modules/approval-requests/dto/approval-request-reason.dto';
import { ApprovalRequestsQueryDto as D23 } from '../modules/approval-requests/dto/approval-requests-query.dto';
import { MyApprovalRequestsQueryDto as D24 } from '../modules/approval-requests/dto/my-approval-requests-query.dto';
import { ResolveApprovalRequestDto as D25 } from '../modules/approval-requests/dto/resolve-approval-request.dto';
import { AssignmentTrainingInputDto as D26 } from '../modules/assignments/dto/assignment-training-input.dto';
import { AutoAssignmentRuleDayDto as D27 } from '../modules/assignments/dto/auto-assignment-rule.dto';
import { CreateAutoAssignmentRuleDto as D28 } from '../modules/assignments/dto/auto-assignment-rule.dto';
import { GetActiveAutoAssignmentRuleQueryDto as D29 } from '../modules/assignments/dto/auto-assignment-rule.dto';
import { BatchAssignmentDayDto as D30 } from '../modules/assignments/dto/batch-assign-days.dto';
import { BatchAssignDaysDto as D31 } from '../modules/assignments/dto/batch-assign-days.dto';
import { BulkAssignmentDto as D32 } from '../modules/assignments/dto/bulk-assign.dto';
import { CopyWeekDto as D33 } from '../modules/assignments/dto/bulk-assign.dto';
import { CopySelectionDto as D34 } from '../modules/assignments/dto/bulk-assign.dto';
import { DeleteAssignmentsDto as D35 } from '../modules/assignments/dto/delete-assignments.dto';
import { GetMonthAssignmentsQueryDto as D36 } from '../modules/assignments/dto/get-month-assignments-query.dto';
import { GetWeekAssignmentsQueryDto as D37 } from '../modules/assignments/dto/get-week-assignments-query.dto';
import { UpdateRirCycleDto as D38 } from '../modules/assignments/dto/rir-cycle.dto';
import { UpdateAssignmentDto as D39 } from '../modules/assignments/dto/update-assignment.dto';
import { LoginDto as D40 } from '../modules/auth/dto/login.dto';
import { SocialLoginDto as D41 } from '../modules/auth/dto/login.dto';
import { ForgotPasswordDto as D42 } from '../modules/auth/dto/login.dto';
import { RefreshTokenDto as D43 } from '../modules/auth/dto/login.dto';
import { ChallengesQueryDto as D44 } from '../modules/challenges/dto/challenges-query.dto';
import { ChallengeAssignmentsQueryDto as D45 } from '../modules/challenges/dto/challenges-query.dto';
import { CreateChallengeDto as D46 } from '../modules/challenges/dto/create-challenge.dto';
import { UpdateChallengeDto as D47 } from '../modules/challenges/dto/create-challenge.dto';
import { AssignChallengeDto as D48 } from '../modules/challenges/dto/create-challenge.dto';
import { UpdateProgressDto as D49 } from '../modules/challenges/dto/create-challenge.dto';
import { AdminDashboardResponseDto as D50 } from '../modules/dashboard/dto/admin-dashboard-response.dto';
import { MealIngredientDto as D51 } from '../modules/diets/dto/create-diet.dto';
import { CreateMealVariantDto as D52 } from '../modules/diets/dto/create-diet.dto';
import { CreateMealDto as D53 } from '../modules/diets/dto/create-diet.dto';
import { CreateDietDto as D54 } from '../modules/diets/dto/create-diet.dto';
import { UpdateDietDto as D55 } from '../modules/diets/dto/create-diet.dto';
import { DietNutritionalBadgesResponseDto as D56 } from '../modules/diets/dto/diet-nutritional-badges-response.dto';
import { DietTagsResponseDto as D57 } from '../modules/diets/dto/diet-tags-response.dto';
import { DietsQueryDto as D58 } from '../modules/diets/dto/diets-query.dto';
import { FindMonthDietQueryDto as D59 } from '../modules/diets/dto/find-month-diet-query.dto';
import { FindTodayDietQueryDto as D60 } from '../modules/diets/dto/find-today-diet-query.dto';
import { FindWeekDietQueryDto as D61 } from '../modules/diets/dto/find-week-diet-query.dto';
import { CreateExerciseDto as D62 } from '../modules/exercises/dto/create-exercise.dto';
import { UpdateExerciseDto as D63 } from '../modules/exercises/dto/create-exercise.dto';
import { ExerciseEquipmentResponseDto as D64 } from '../modules/exercises/dto/exercise-equipment-response.dto';
import { ExerciseMuscleGroupsResponseDto as D65 } from '../modules/exercises/dto/exercise-muscle-groups-response.dto';
import { ExercisesQueryDto as D66 } from '../modules/exercises/dto/exercises-query.dto';
import { AdminFeedbackQueryDto as D67 } from '../modules/feedback/dto/admin-feedback-query.dto';
import { CreateFeedbackDto as D68 } from '../modules/feedback/dto/create-feedback.dto';
import { RespondFeedbackDto as D69 } from '../modules/feedback/dto/create-feedback.dto';
import { CreateIngredientDto as D70 } from '../modules/ingredients/dto/create-ingredient.dto';
import { UpdateIngredientDto as D71 } from '../modules/ingredients/dto/create-ingredient.dto';
import { IngredientsQueryDto as D72 } from '../modules/ingredients/dto/ingredients-query.dto';
import { CreateMealBodyDto as D73 } from '../modules/meals/dto/create-meal.dto';
import { UpdateMealDto as D74 } from '../modules/meals/dto/update-meal.dto';
import { CreateBodyMetricDto as D75 } from '../modules/metrics/dto/create-metric.dto';
import { MetricsOverviewQueryDto as D76 } from '../modules/metrics/dto/metrics-overview-query.dto';
import { MyNotificationsQueryDto as D77 } from '../modules/notifications/dto/my-notifications-query.dto';
import { NotificationQueryDto as D78 } from '../modules/notifications/dto/notification-query.dto';
import { CreateNotificationTemplateDto as D79 } from '../modules/notifications/dto/notification-template.dto';
import { UpdateNotificationTemplateDto as D80 } from '../modules/notifications/dto/notification-template.dto';
import { UpdateNotificationTemplateScheduleDto as D81 } from '../modules/notifications/dto/notification-template.dto';
import { NotificationContentDto as D82 } from '../modules/notifications/dto/send-notification.dto';
import { SendNotificationDto as D83 } from '../modules/notifications/dto/send-notification.dto';
import { SendToAllClientsDto as D84 } from '../modules/notifications/dto/send-notification.dto';
import { UpdateProfileDto as D85 } from '../modules/profile/dto/update-profile.dto';
import { CreateProgressPhotoSessionDto as D86 } from '../modules/progress-photos/dto/progress-photo.dto';
import { AssociateProgressPhotoDto as D87 } from '../modules/progress-photos/dto/progress-photo.dto';
import { ProgressPhotoHistoryQueryDto as D88 } from '../modules/progress-photos/dto/progress-photo.dto';
import { CompletedSetDto as D89 } from '../modules/progress/dto/mark-completed.dto';
import { MarkExerciseDto as D90 } from '../modules/progress/dto/mark-completed.dto';
import { MarkMealDto as D91 } from '../modules/progress/dto/mark-completed.dto';
import { CompleteTrainingDto as D92 } from '../modules/progress/dto/mark-completed.dto';
import { TrainingProgressRangeQueryDto as D93 } from '../modules/progress/dto/training-progress-query.dto';
import { TrainingOverviewQueryDto as D94 } from '../modules/progress/dto/training-progress-query.dto';
import { TrainingProgressPageQueryDto as D95 } from '../modules/progress/dto/training-progress-query.dto';
import { TrainingProgressLoadQueryDto as D96 } from '../modules/progress/dto/training-progress-query.dto';
import { TrainingProgressSessionParamsDto as D97 } from '../modules/progress/dto/training-progress-query.dto';
import { MobileAppConfigResponseDto as D98 } from '../modules/public-config/dto/mobile-app-config-response.dto';
import { UpdateMobileReleaseDto as D99 } from '../modules/public-config/dto/update-mobile-release.dto';
import { AdminRecapQueryDto as D100 } from '../modules/recaps/dto/admin-recap-query.dto';
import { CreateRecapDto as D101 } from '../modules/recaps/dto/create-recap.dto';
import { UpdateRecapDto as D102 } from '../modules/recaps/dto/create-recap.dto';
import { ReviewRecapDto as D103 } from '../modules/recaps/dto/create-recap.dto';
import { TrainingExerciseDto as D104 } from '../modules/trainings/dto/create-training.dto';
import { TrainingItemExerciseDto as D105 } from '../modules/trainings/dto/create-training.dto';
import { TrainingCircuitExerciseDto as D106 } from '../modules/trainings/dto/create-training.dto';
import { TrainingCircuitItemDto as D107 } from '../modules/trainings/dto/create-training.dto';
import { CreateTrainingDto as D108 } from '../modules/trainings/dto/create-training.dto';
import { UpdateTrainingDto as D109 } from '../modules/trainings/dto/create-training.dto';
import { TrainingTagsResponseDto as D110 } from '../modules/trainings/dto/training-tags-response.dto';
import { TrainingTypesResponseDto as D111 } from '../modules/trainings/dto/training-types-response.dto';
import { TrainingsQueryDto as D112 } from '../modules/trainings/dto/trainings-query.dto';
import { AdminClientCalendarMonthQueryDto as D113 } from '../modules/users/dto/admin-client-calendar-query.dto';
import { AdminClientCalendarWeekQueryDto as D114 } from '../modules/users/dto/admin-client-calendar-query.dto';
import { CreateAdminClientMetricDto as D115 } from '../modules/users/dto/admin-client-metric.dto';
import { UpdateAdminClientMetricDto as D116 } from '../modules/users/dto/admin-client-metric.dto';
import { AdminClientBodyHistoryQueryDto as D117 } from '../modules/users/dto/admin-client-metrics-query.dto';
import { AdminClientProgressQueryDto as D118 } from '../modules/users/dto/admin-client-progress-query.dto';
import { ReplyToTrainingNoteDto as D119 } from '../modules/users/dto/admin-client-progress-query.dto';
import { AdminClientsQueryDto as D120 } from '../modules/users/dto/admin-clients-query.dto';
import { AdminUsersQueryDto as D121 } from '../modules/users/dto/admin-users-query.dto';
import { ArchiveClientDto as D122 } from '../modules/users/dto/archive-client.dto';
import { ClientAssignmentResponseDto as D123 } from '../modules/users/dto/client-assignment-response.dto';
import { CreateClientDto as D124 } from '../modules/users/dto/create-client.dto';
import { UpdateRoleDto as D125 } from '../modules/users/dto/create-client.dto';
import { CreateAdminDto as D126 } from '../modules/users/dto/manage-user.dto';
import { UpdateUserDto as D127 } from '../modules/users/dto/manage-user.dto';
import { UpdateUserStatusDto as D128 } from '../modules/users/dto/manage-user.dto';
import { UpdateClientAssignmentsDto as D129 } from '../modules/users/dto/update-client-assignments.dto';
import { UpdateClientProfileDto as D130 } from '../modules/users/dto/update-client-profile.dto';
export const requestDtos = [
  D0,
  D1,
  D2,
  D3,
  D4,
  D5,
  D6,
  D7,
  D8,
  D9,
  D10,
  D11,
  D12,
  D13,
  D14,
  D15,
  D16,
  D17,
  D18,
  D19,
  D20,
  D21,
  D22,
  D23,
  D24,
  D25,
  D26,
  D27,
  D28,
  D29,
  D30,
  D31,
  D32,
  D33,
  D34,
  D35,
  D36,
  D37,
  D38,
  D39,
  D40,
  D41,
  D42,
  D43,
  D44,
  D45,
  D46,
  D47,
  D48,
  D49,
  D50,
  D51,
  D52,
  D53,
  D54,
  D55,
  D56,
  D57,
  D58,
  D59,
  D60,
  D61,
  D62,
  D63,
  D64,
  D65,
  D66,
  D67,
  D68,
  D69,
  D70,
  D71,
  D72,
  D73,
  D74,
  D75,
  D76,
  D77,
  D78,
  D79,
  D80,
  D81,
  D82,
  D83,
  D84,
  D85,
  D86,
  D87,
  D88,
  D89,
  D90,
  D91,
  D92,
  D93,
  D94,
  D95,
  D96,
  D97,
  D98,
  D99,
  D100,
  D101,
  D102,
  D103,
  D104,
  D105,
  D106,
  D107,
  D108,
  D109,
  D110,
  D111,
  D112,
  D113,
  D114,
  D115,
  D116,
  D117,
  D118,
  D119,
  D120,
  D121,
  D122,
  D123,
  D124,
  D125,
  D126,
  D127,
  D128,
  D129,
  D130,
];
