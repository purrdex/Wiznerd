-- Wiznerd Platform — NFT indexer tables
-- Run after 010_collection_metadata.sql

-- ── Indexed collections (backfill + on-chain discovery) ───────────────────────
create table if not exists indexed_collections (
  id               uuid primary key default gen_random_uuid(),
  collection_id    text unique not null,  -- MintGarden encoded_id or CHIP-0007 collection.id
  name             text not null default 'Unknown',
  description      text,
  thumbnail_url    text,
  total_supply     integer default 0,
  minted_count     integer default 0,
  floor_price_mojo bigint default 0,
  creator_did      text,
  source           text not null default 'onchain',  -- 'mintgarden' | 'onchain'
  external_url     text,
  verified         boolean default false,
  last_seen_block  bigint,
  updated_at       timestamptz default now(),
  created_at       timestamptz default now()
);

create index if not exists idx_collections_source  on indexed_collections(source);
create index if not exists idx_collections_name    on indexed_collections using gin(to_tsvector('english', name));
create index if not exists idx_collections_updated on indexed_collections(updated_at desc);

-- ── Indexed NFTs (individual tokens found on-chain) ───────────────────────────
create table if not exists indexed_nfts (
  id                uuid primary key default gen_random_uuid(),
  nft_id            text unique not null,  -- nft1... launcher ID
  collection_id     text,
  token_index       integer,
  name              text,
  metadata_uri      text,
  image_url         text,
  data_hash         text,
  meta_hash         text,
  owner_puzzle_hash text,
  minter_did        text,
  confirmed_block   bigint,
  traits            jsonb default '{}',
  indexed_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

create index if not exists idx_nfts_collection_id    on indexed_nfts(collection_id);
create index if not exists idx_nfts_minter_did       on indexed_nfts(minter_did);
create index if not exists idx_nfts_owner_puzzle_hash on indexed_nfts(owner_puzzle_hash);

-- ── Indexer state (persists last processed block across restarts) ─────────────
create table if not exists indexer_state (
  id                integer primary key default 1,
  last_block_height bigint default 0,
  last_block_hash   text,
  updated_at        timestamptz default now()
);

-- ── Table-level grants (required for SQL-editor-created tables in Supabase) ──
grant all on indexed_collections to service_role;
grant all on indexed_nfts        to service_role;
grant all on indexer_state       to service_role;
grant select on indexed_collections to anon, authenticated;
grant select on indexed_nfts        to anon, authenticated;

-- ── RLS ───────────────────────────────────────────────────────────────────────
alter table indexed_collections enable row level security;
alter table indexed_nfts        enable row level security;
alter table indexer_state       enable row level security;

do $$ begin
  create policy "public read indexed_collections" on indexed_collections for select using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "service_role all indexed_collections" on indexed_collections
    for all to service_role using (true) with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "public read indexed_nfts" on indexed_nfts for select using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "service_role all indexed_nfts" on indexed_nfts
    for all to service_role using (true) with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "service_role all indexer_state" on indexer_state
    for all to service_role using (true) with check (true);
exception when duplicate_object then null; end $$;
