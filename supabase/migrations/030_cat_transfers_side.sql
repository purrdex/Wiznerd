ALTER TABLE cat_transfers
  ADD COLUMN IF NOT EXISTS side text CHECK (side IN ('buy', 'sell'));
