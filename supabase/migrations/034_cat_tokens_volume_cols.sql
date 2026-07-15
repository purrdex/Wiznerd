-- Add volume and sparkline columns to cat_tokens.
-- refreshTokenStats() in token-indexer.js upserts these every 5 minutes
-- from cat_transfers via get_token_volumes() and get_token_sparklines().
-- Without these columns the upsert silently fails and volumes show as 0.

ALTER TABLE cat_tokens
  ADD COLUMN IF NOT EXISTS volume_24h_xch numeric  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS volume_7d_xch  numeric  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sparkline_7d   numeric[] DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_cat_tokens_volume_7d
  ON cat_tokens (volume_7d_xch DESC);
