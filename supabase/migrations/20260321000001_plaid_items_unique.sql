-- Add unique constraint on plaid_item_id to support upsert with onConflict
ALTER TABLE plaid_items ADD CONSTRAINT plaid_items_plaid_item_id_key UNIQUE (plaid_item_id);
