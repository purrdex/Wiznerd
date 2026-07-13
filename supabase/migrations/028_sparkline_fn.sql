-- Computes daily close prices from cat_transfers for 7-day sparklines.
-- Returns one row per (asset_id, day) with the last trade price of that day.
-- This bypasses cat_ohlcv so sparklines work as soon as cat_transfers has data.

CREATE OR REPLACE FUNCTION get_token_sparklines(
  p_asset_ids text[],
  p_since     timestamptz
) RETURNS TABLE (
  asset_id    text,
  day_start   timestamptz,
  close_price double precision
) LANGUAGE sql STABLE AS $$
  SELECT
    asset_id,
    DATE_TRUNC('day', transferred_at)              AS day_start,
    (ARRAY_AGG(price_xch::double precision
               ORDER BY transferred_at DESC))[1]   AS close_price
  FROM cat_transfers
  WHERE asset_id = ANY(p_asset_ids)
    AND transferred_at >= p_since
    AND price_xch IS NOT NULL
  GROUP BY asset_id, DATE_TRUNC('day', transferred_at)
  ORDER BY asset_id, day_start;
$$;

GRANT EXECUTE ON FUNCTION get_token_sparklines(text[], timestamptz)
  TO service_role, anon, authenticated;
