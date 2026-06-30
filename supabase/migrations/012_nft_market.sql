-- NFT market features: rarity scores, offer board, transfer history

-- Add rarity columns to indexed_nfts
alter table indexed_nfts
  add column if not exists rarity_score  float,
  add column if not exists rarity_rank   integer;

create index if not exists idx_indexed_nfts_rarity
  on indexed_nfts(collection_id, rarity_rank);

-- Open offer board (native Chia .offer files)
create table if not exists nft_offers (
  id              uuid primary key default gen_random_uuid(),
  nft_id          text not null,
  collection_id   text,
  offer_string    text not null,          -- raw .offer file contents
  offer_type      text not null check (offer_type in ('ask','bid')),
                                          -- ask = selling NFT for XCH
                                          -- bid = buying NFT for XCH
  price_mojo      bigint not null,
  maker_puzzle_hash text,
  status          text not null default 'open'
                      check (status in ('open','taken','cancelled','expired')),
  expires_at      timestamptz,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create index if not exists idx_nft_offers_nft    on nft_offers(nft_id, status);
create index if not exists idx_nft_offers_col    on nft_offers(collection_id, status);
create index if not exists idx_nft_offers_status on nft_offers(status, created_at desc);

-- Transfer history (populated by block watcher on NFT moves)
create table if not exists nft_transfers (
  id              bigserial primary key,
  nft_id          text not null,
  collection_id   text,
  from_puzzle_hash text,
  to_puzzle_hash  text,
  price_mojo      bigint,                 -- null if gifted/non-sale transfer
  block_height    bigint,
  transferred_at  timestamptz,
  created_at      timestamptz default now()
);

create index if not exists idx_nft_transfers_nft on nft_transfers(nft_id, block_height desc);
create index if not exists idx_nft_transfers_col on nft_transfers(collection_id, transferred_at desc);

-- RLS + grants
alter table nft_offers    enable row level security;
alter table nft_transfers enable row level security;

grant all    on nft_offers    to service_role;
grant all    on nft_transfers to service_role;
grant select on nft_offers    to anon, authenticated;
grant select on nft_transfers to anon, authenticated;

-- Anyone can read offers; only service_role writes them (via server)
create policy "public read offers"     on nft_offers    for select using (true);
create policy "public read transfers"  on nft_transfers for select using (true);
