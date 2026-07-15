-- Fix 24h volume mismatch between token list and token detail page.
-- Token detail queries cat_transfers WHERE price_xch IS NOT NULL (trades only).
-- get_token_volumes was counting LP add/remove events (price_xch IS NULL) too.
-- Align them by adding the same filter here.

DROP FUNCTION IF EXISTS get_token_volumes(text[], timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION get_token_volumes(
  asset_ids text[],
  since_7d  timestamptz,
  since_24h timestamptz
) RETURNS TABLE (
  asset_id text,
  vol_24h  numeric,
  vol_7d   numeric
) LANGUAGE sql STABLE AS $$
  SELECT
    asset_id,
    SUM(volume_xch) FILTER (WHERE transferred_at >= since_24h) AS vol_24h,
    SUM(volume_xch) FILTER (WHERE transferred_at >= since_7d)  AS vol_7d
  FROM cat_transfers
  WHERE transferred_at >= since_7d
    AND volume_xch  IS NOT NULL
    AND price_xch   IS NOT NULL
  GROUP BY asset_id;
$$;

GRANT EXECUTE ON FUNCTION get_token_volumes(text[], timestamptz, timestamptz)
  TO service_role, anon, authenticated;
