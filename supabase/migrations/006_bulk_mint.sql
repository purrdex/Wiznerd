-- v1.1.0 Bulk mint support
-- Run after 005_token_locking.sql in the Supabase SQL editor

alter table orders add column if not exists quantity     integer   default 1;
alter table orders add column if not exists minted_count integer   default 0;
alter table orders add column if not exists token_ids   uuid[]    default '{}';
