alter table indexed_collections
  add column if not exists listed_count integer default 0;
