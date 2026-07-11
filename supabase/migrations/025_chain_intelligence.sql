-- ── v1.6 Chain Intelligence ───────────────────────────────────────────────────
-- New tables: indexed_blocks, cat_tokens, cat_transfers, cat_ohlcv,
--             tibet_pairs, lp_snapshots
-- Also: event_type column on nft_transfers

-- ── indexed_blocks ────────────────────────────────────────────────────────────
-- Tracks every block processed by the forward or backward indexer.
-- Both indexers check here before processing a block to avoid double work.

CREATE TABLE IF NOT EXISTS indexed_blocks (
  block_height  bigint      PRIMARY KEY,
  processed_at  timestamptz DEFAULT now(),
  nft_events    integer     DEFAULT 0,
  cat_events    integer     DEFAULT 0
);

GRANT ALL    ON indexed_blocks TO service_role;
GRANT SELECT ON indexed_blocks TO anon, authenticated;

ALTER TABLE indexed_blocks ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "public read indexed_blocks" ON indexed_blocks FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "service_role all indexed_blocks" ON indexed_blocks
    FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── nft_transfers: event_type ─────────────────────────────────────────────────
-- Distinguishes mint (first time NFT appears) vs transfer vs sale on-chain.
ALTER TABLE nft_transfers
  ADD COLUMN IF NOT EXISTS event_type text DEFAULT 'transfer'
    CHECK (event_type IN ('mint', 'transfer', 'sale'));

-- ── cat_tokens ────────────────────────────────────────────────────────────────
-- One row per CAT2 token that has Dexie trade activity or a Tibet pair.

CREATE TABLE IF NOT EXISTS cat_tokens (
  asset_id       text        PRIMARY KEY,  -- 64-char hex tail hash
  name           text,
  short_name     text,
  image_url      text,
  tibet_pair_id  text,                     -- launcher_id from tibet_pairs
  first_seen_at  timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cat_tokens_name ON cat_tokens (name);

GRANT ALL    ON cat_tokens TO service_role;
GRANT SELECT ON cat_tokens TO anon, authenticated;

ALTER TABLE cat_tokens ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "public read cat_tokens" ON cat_tokens FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "service_role all cat_tokens" ON cat_tokens
    FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── cat_transfers ─────────────────────────────────────────────────────────────
-- Individual CAT trades sourced from Dexie completed offers.
-- price_xch is XCH per 1 token (normalized).

CREATE TABLE IF NOT EXISTS cat_transfers (
  id              bigserial   PRIMARY KEY,
  asset_id        text        NOT NULL REFERENCES cat_tokens(asset_id) ON DELETE CASCADE,
  offer_id        text,                    -- Dexie offer ID for dedup
  price_xch       numeric(20,12),          -- XCH paid per token (null = NFT-NFT or CAT swap)
  amount_tokens   numeric(30,3),           -- how many tokens changed hands
  volume_xch      numeric(20,12),          -- price_xch * amount_tokens (total XCH value)
  block_height    bigint,
  transferred_at  timestamptz NOT NULL,
  source          text        NOT NULL DEFAULT 'dexie',
  created_at      timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cat_transfers_offer
  ON cat_transfers (offer_id)
  WHERE offer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cat_transfers_asset_time
  ON cat_transfers (asset_id, transferred_at DESC);

CREATE INDEX IF NOT EXISTS idx_cat_transfers_block
  ON cat_transfers (block_height)
  WHERE block_height IS NOT NULL;

GRANT ALL    ON cat_transfers TO service_role;
GRANT SELECT ON cat_transfers TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE cat_transfers_id_seq TO service_role;

ALTER TABLE cat_transfers ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "public read cat_transfers" ON cat_transfers FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "service_role all cat_transfers" ON cat_transfers
    FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── cat_ohlcv ─────────────────────────────────────────────────────────────────
-- Pre-aggregated OHLCV candles built from cat_transfers.
-- Timeframes: 1h, 4h, 1d, 1w, 1m
-- bucket_start is always the start of the period (UTC).

CREATE TABLE IF NOT EXISTS cat_ohlcv (
  id           bigserial   PRIMARY KEY,
  asset_id     text        NOT NULL REFERENCES cat_tokens(asset_id) ON DELETE CASCADE,
  timeframe    text        NOT NULL CHECK (timeframe IN ('1h','4h','1d','1w','1m')),
  bucket_start timestamptz NOT NULL,
  open         numeric(20,12) NOT NULL,
  high         numeric(20,12) NOT NULL,
  low          numeric(20,12) NOT NULL,
  close        numeric(20,12) NOT NULL,
  volume_xch   numeric(20,12) NOT NULL DEFAULT 0,
  trade_count  integer        NOT NULL DEFAULT 0,
  updated_at   timestamptz DEFAULT now(),
  UNIQUE (asset_id, timeframe, bucket_start)
);

CREATE INDEX IF NOT EXISTS idx_cat_ohlcv_asset_tf_bucket
  ON cat_ohlcv (asset_id, timeframe, bucket_start DESC);

GRANT ALL    ON cat_ohlcv TO service_role;
GRANT SELECT ON cat_ohlcv TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE cat_ohlcv_id_seq TO service_role;

ALTER TABLE cat_ohlcv ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "public read cat_ohlcv" ON cat_ohlcv FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "service_role all cat_ohlcv" ON cat_ohlcv
    FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── tibet_pairs ───────────────────────────────────────────────────────────────
-- One row per Tibet LP pair. Synced nightly from Tibet API GET /pairs.

CREATE TABLE IF NOT EXISTS tibet_pairs (
  launcher_id    text        PRIMARY KEY,  -- Tibet pair launcher ID
  asset_id       text        REFERENCES cat_tokens(asset_id) ON DELETE SET NULL,
  xch_reserve    bigint      DEFAULT 0,    -- mojos
  token_reserve  bigint      DEFAULT 0,    -- token mojos
  liquidity      bigint      DEFAULT 0,    -- LP tokens outstanding
  fee_rate       numeric(6,4) DEFAULT 0.003,
  current_price_xch numeric(20,12),       -- derived: xch_reserve / token_reserve (normalized)
  updated_at     timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tibet_pairs_asset ON tibet_pairs (asset_id);

GRANT ALL    ON tibet_pairs TO service_role;
GRANT SELECT ON tibet_pairs TO anon, authenticated;

ALTER TABLE tibet_pairs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "public read tibet_pairs" ON tibet_pairs FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "service_role all tibet_pairs" ON tibet_pairs
    FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── lp_snapshots ─────────────────────────────────────────────────────────────
-- Periodic reserve snapshots per Tibet pair (1 per hour via cron).
-- Powers the LP TVL chart on the token detail page.

CREATE TABLE IF NOT EXISTS lp_snapshots (
  id            bigserial   PRIMARY KEY,
  launcher_id   text        NOT NULL REFERENCES tibet_pairs(launcher_id) ON DELETE CASCADE,
  xch_reserve   bigint      NOT NULL,
  token_reserve bigint      NOT NULL,
  price_xch     numeric(20,12),
  snapped_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (launcher_id, snapped_at)
);

CREATE INDEX IF NOT EXISTS idx_lp_snapshots_pair_time
  ON lp_snapshots (launcher_id, snapped_at DESC);

GRANT ALL    ON lp_snapshots TO service_role;
GRANT SELECT ON lp_snapshots TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE lp_snapshots_id_seq TO service_role;

ALTER TABLE lp_snapshots ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "public read lp_snapshots" ON lp_snapshots FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "service_role all lp_snapshots" ON lp_snapshots
    FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
