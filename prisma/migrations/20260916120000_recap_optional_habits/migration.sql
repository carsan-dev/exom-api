-- Additive: old clients omit these fields; historical observations stay NULL.
BEGIN;
ALTER TABLE weekly_recaps
  ADD COLUMN hunger_level INTEGER CHECK (hunger_level BETWEEN 1 AND 10),
  ADD COLUMN energy_level INTEGER CHECK (energy_level BETWEEN 1 AND 10),
  ADD COLUMN digestion_level INTEGER CHECK (digestion_level BETWEEN 1 AND 10);
COMMIT;
