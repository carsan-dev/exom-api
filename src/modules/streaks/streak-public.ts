// Internal invalidation counters never cross API boundaries (BigInt is not JSON).
export const STREAK_PUBLIC_SELECT = {
  id: true,
  client_id: true,
  current_days: true,
  longest_days: true,
  last_active_date: true,
  tracking_started_at: true,
  updated_at: true,
} as const;
