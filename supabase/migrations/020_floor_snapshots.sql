-- Floor price snapshots — captured hourly by the trending job
-- Used for floor history charts and % change indicators on collection pages.

CREATE TABLE IF NOT EXISTS floor_snapshots (
  id             bigserial PRIMARY KEY,
  collection_id  text        NOT NULL,
  floor_price_mojo bigint,
  snapshot_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS floor_snapshots_col_time
  ON floor_snapshots (collection_id, snapshot_at DESC);

-- Auto-purge snapshots older than 90 days (keep history lean)
CREATE OR REPLACE FUNCTION purge_old_floor_snapshots() RETURNS void LANGUAGE sql AS $$
  DELETE FROM floor_snapshots WHERE snapshot_at < now() - interval '90 days';
$$;
