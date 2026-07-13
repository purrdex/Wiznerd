-- ── v1.7 Token Indexer ────────────────────────────────────────────────────────
-- Adds pair_coin_id tracking, token indexer state, open offer orderbook,
-- and event_type on cat_transfers. Also fixes cat_ohlcv timeframe constraint.

-- ── tibet_pairs: pair_coin_id ─────────────────────────────────────────────────
-- Tracks the current unspent singleton coin for each Tibet pair.
-- Updated in-place by the token indexer every time a swap/LP event is detected.
ALTER TABLE tibet_pairs ADD COLUMN IF NOT EXISTS pair_coin_id      TEXT;
ALTER TABLE tibet_pairs ADD COLUMN IF NOT EXISTS pair_coin_height  BIGINT;

-- ── cat_transfers: event_type ─────────────────────────────────────────────────
-- Distinguishes on-chain TibetSwap trades from Dexie offer completions,
-- LP adds/removes, and future transfer/burn tracking.
ALTER TABLE cat_transfers ADD COLUMN IF NOT EXISTS event_type TEXT DEFAULT 'trade';

-- ── cat_ohlcv: expand timeframe check ────────────────────────────────────────
-- Original migration only allowed ('1h','4h','1d','1w','1m').
-- cat-sync.js and the new token indexer need '1min', '15min', and '3mo'.
DO $fix$ BEGIN
  ALTER TABLE cat_ohlcv DROP CONSTRAINT IF EXISTS cat_ohlcv_timeframe_check;
EXCEPTION WHEN undefined_object THEN NULL; END $fix$;

ALTER TABLE cat_ohlcv ADD CONSTRAINT cat_ohlcv_timeframe_check
  CHECK (timeframe IN ('1min','15min','1h','4h','1d','1w','1m','3mo'));

-- ── token_indexer_state ───────────────────────────────────────────────────────
-- Persists the last block processed by the token indexer so restarts resume
-- without re-scanning. Single row, id=1.

CREATE TABLE IF NOT EXISTS token_indexer_state (
  id              INT         PRIMARY KEY DEFAULT 1,
  last_height     BIGINT,
  last_hash       TEXT,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

GRANT ALL    ON token_indexer_state TO service_role;
GRANT SELECT ON token_indexer_state TO anon, authenticated;

ALTER TABLE token_indexer_state ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "public read token_indexer_state" ON token_indexer_state FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "service_role all token_indexer_state" ON token_indexer_state
    FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── cat_offers ────────────────────────────────────────────────────────────────
-- Open (and recently closed) Dexie orderbook entries per CAT token.
-- Polled every 5 minutes from Dexie /v1/offers?status=1.

CREATE TABLE IF NOT EXISTS cat_offers (
  offer_id        TEXT        PRIMARY KEY,
  asset_id        TEXT        NOT NULL REFERENCES cat_tokens(asset_id) ON DELETE CASCADE,
  offer_type      TEXT        NOT NULL CHECK (offer_type IN ('buy', 'sell')),
  price_xch       NUMERIC,    -- XCH per 1 token unit
  amount_tokens   NUMERIC,    -- total token quantity in the offer
  volume_xch      NUMERIC,    -- price_xch * amount_tokens
  status          TEXT        DEFAULT 'open',
  dexie_status    INT,        -- raw Dexie status code
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cat_offers_asset_status ON cat_offers(asset_id, status);
CREATE INDEX IF NOT EXISTS idx_cat_offers_updated      ON cat_offers(updated_at DESC);

GRANT ALL    ON cat_offers TO service_role;
GRANT SELECT ON cat_offers TO anon, authenticated;

ALTER TABLE cat_offers ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "public read cat_offers" ON cat_offers FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "service_role all cat_offers" ON cat_offers
    FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
