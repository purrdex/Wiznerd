-- ── v1.7 Trending aggregation functions ──────────────────────────────────────
-- Replaces paginated JS loops in trending.js with DB-side GROUP BY queries.
-- Each function runs as a single statement, respects existing indexes, and
-- returns only the aggregated result — no row-by-row transfer to Node.

-- ── get_collection_stats ──────────────────────────────────────────────────────
-- Returns per-collection transfer volume and sale counts for 7d and 24h windows.
CREATE OR REPLACE FUNCTION get_collection_stats(
  since_7d  timestamptz,
  since_24h timestamptz
) RETURNS TABLE (
  collection_id text,
  vol_7d        numeric,
  vol_24h       numeric,
  sales_7d      bigint,
  sales_24h     bigint
) LANGUAGE sql STABLE AS
$func$
  SELECT
    collection_id,
    SUM(price_mojo) FILTER (WHERE transferred_at >= since_7d)::numeric   AS vol_7d,
    SUM(price_mojo) FILTER (WHERE transferred_at >= since_24h)::numeric  AS vol_24h,
    COUNT(*)        FILTER (WHERE transferred_at >= since_7d)             AS sales_7d,
    COUNT(*)        FILTER (WHERE transferred_at >= since_24h)            AS sales_24h
  FROM nft_transfers
  WHERE transferred_at >= since_7d
    AND collection_id IS NOT NULL
  GROUP BY collection_id;
$func$;

-- ── get_collection_mint_counts ────────────────────────────────────────────────
-- Returns count of recently-active NFTs per collection (proxy for mint activity).
CREATE OR REPLACE FUNCTION get_collection_mint_counts(
  since_24h timestamptz
) RETURNS TABLE (
  collection_id text,
  mint_count    bigint
) LANGUAGE sql STABLE AS
$func$
  SELECT collection_id, COUNT(*) AS mint_count
  FROM indexed_nfts
  WHERE updated_at >= since_24h
    AND collection_id IS NOT NULL
  GROUP BY collection_id;
$func$;

-- ── get_collection_listed_counts ──────────────────────────────────────────────
-- Returns open ask count per collection by joining nft_offers → indexed_nfts.
CREATE OR REPLACE FUNCTION get_collection_listed_counts()
RETURNS TABLE (
  collection_id text,
  listed_count  bigint
) LANGUAGE sql STABLE AS
$func$
  SELECT n.collection_id, COUNT(*) AS listed_count
  FROM nft_offers o
  JOIN indexed_nfts n ON n.nft_id = o.nft_id
  WHERE o.status    = 'open'
    AND o.offer_type = 'ask'
    AND n.collection_id IS NOT NULL
  GROUP BY n.collection_id;
$func$;

-- Grant execute to service_role (anon/authenticated don't need these)
GRANT EXECUTE ON FUNCTION get_collection_stats(timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION get_collection_mint_counts(timestamptz)        TO service_role;
GRANT EXECUTE ON FUNCTION get_collection_listed_counts()                  TO service_role;
