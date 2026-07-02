-- Trending score columns on indexed_collections

alter table indexed_collections
  add column if not exists trending_score  float8  default 0,
  add column if not exists volume_24h_mojo bigint  default 0,
  add column if not exists volume_7d_mojo  bigint  default 0,
  add column if not exists sales_24h       integer default 0,
  add column if not exists sales_7d        integer default 0,
  add column if not exists mint_24h        integer default 0;

create index if not exists idx_indexed_collections_trending
  on indexed_collections(trending_score desc)
  where trending_score > 0;
