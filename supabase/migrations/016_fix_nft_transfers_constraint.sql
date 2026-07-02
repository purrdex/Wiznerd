-- Fix: partial unique index can't be used as ON CONFLICT target in PostgREST/Supabase.
-- Replace with a non-partial unique index.
--
-- PostgreSQL standard: NULL != NULL, so UNIQUE(nft_id, block_height) without a WHERE clause
-- still allows multiple rows where block_height IS NULL (platform/Wiznerd trades).
-- Non-null block_heights remain unique per NFT (Dexie/on-chain trades), and the
-- non-partial index works as an ON CONFLICT target for PostgREST upserts.

-- Remove any duplicate dexie rows from failed re-runs (keeps first-inserted row)
DELETE FROM nft_transfers a
USING nft_transfers b
WHERE a.ctid > b.ctid
  AND a.nft_id       = b.nft_id
  AND a.block_height = b.block_height
  AND a.block_height IS NOT NULL;

-- Drop the old partial index
DROP INDEX IF EXISTS idx_nft_transfers_nft_block;

-- Non-partial unique index: works as ON CONFLICT target in PostgREST
-- NULL block_heights are never equal to each other so no uniqueness issue for platform trades
CREATE UNIQUE INDEX idx_nft_transfers_nft_block
  ON nft_transfers(nft_id, block_height);
