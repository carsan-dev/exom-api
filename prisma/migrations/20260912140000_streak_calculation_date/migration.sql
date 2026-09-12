-- updated_at is the write time, not the asOf date used by a historical repair.
-- NULL deliberately invalidates previously cached calculations without changing history.
ALTER TABLE streaks ADD COLUMN calculated_for_date DATE;
