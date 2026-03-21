-- Remove unused split_type values; only 'equal' is implemented
ALTER TABLE split_decisions
  DROP CONSTRAINT split_decisions_split_type_check;

ALTER TABLE split_decisions
  ADD CONSTRAINT split_decisions_split_type_check
  CHECK (split_type = 'equal');
