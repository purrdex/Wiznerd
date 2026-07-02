-- Volume tracking: source column + unique constraint for backfill deduplication

alter table nft_transfers
  add column if not exists source text default 'onchain';

-- Unique constraint so volume-backfill.js can upsert without duplicates
-- block_height is null for Wiznerd-platform trades so we only deduplicate MG data
create unique index if not exists idx_nft_transfers_nft_block
  on nft_transfers(nft_id, block_height)
  where block_height is not null;

-- Platform fees: add to projects table for publish endpoint
alter table projects
  add column if not exists creator_price_mojo  bigint default 0,
  add column if not exists platform_fee_mojo   bigint default 0;
