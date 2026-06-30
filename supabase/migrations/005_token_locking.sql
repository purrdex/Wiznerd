-- v1.0.0 Token locking for mint reservation
-- Run after 004_marketplace.sql in the Supabase SQL editor

alter table generated_tokens add column if not exists buyer_address text;
alter table generated_tokens add column if not exists data_hash   text;  -- SHA256 hex of image content
alter table generated_tokens add column if not exists meta_hash   text;  -- SHA256 hex of metadata JSON

create index if not exists generated_tokens_buyer_address_idx on generated_tokens(buyer_address);
create index if not exists generated_tokens_status_idx        on generated_tokens(status);
