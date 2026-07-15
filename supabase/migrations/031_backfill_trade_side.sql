-- Backfill buy/sell side for existing cat_transfers rows.
-- In a constant-product AMM: buying tokens raises the price, selling lowers it.
-- We infer direction by comparing each trade's price to the previous trade
-- for the same asset (ordered by time). First trade per asset stays null.
WITH ranked AS (
  SELECT
    id,
    price_xch,
    LAG(price_xch) OVER (
      PARTITION BY asset_id
      ORDER BY transferred_at, id
    ) AS prev_price
  FROM cat_transfers
  WHERE price_xch IS NOT NULL
)
UPDATE cat_transfers ct
SET side = CASE
  WHEN r.price_xch >= r.prev_price THEN 'buy'
  ELSE 'sell'
END
FROM ranked r
WHERE ct.id = r.id
  AND ct.side IS NULL
  AND r.prev_price IS NOT NULL;
