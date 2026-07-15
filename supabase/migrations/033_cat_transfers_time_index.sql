-- Speed up get_token_volumes which scans cat_transfers by time window across all tokens.
-- The composite (asset_id, transferred_at) index is efficient for per-token queries but
-- not for the full-table time range scan that aggregates volume across all 362 tokens.
CREATE INDEX IF NOT EXISTS idx_cat_transfers_time
  ON cat_transfers (transferred_at DESC)
  WHERE volume_xch IS NOT NULL;
