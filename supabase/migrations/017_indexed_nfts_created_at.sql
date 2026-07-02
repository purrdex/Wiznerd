-- Add created_at to indexed_nfts, set once on first insert (never updated by re-indexing).
-- This gives a reliable primary-mint timestamp for trending mint velocity.

alter table indexed_nfts
  add column if not exists created_at timestamptz default now();

-- Backfill: set created_at = updated_at for existing rows (best approximation)
update indexed_nfts set created_at = updated_at where created_at is null;

create index if not exists idx_indexed_nfts_created_at
  on indexed_nfts(collection_id, created_at desc);
