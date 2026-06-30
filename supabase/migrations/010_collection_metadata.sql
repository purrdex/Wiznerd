-- Wiznerd Platform — collection metadata additions
-- Run in the Supabase SQL editor after 009_order_error_message.sql

alter table projects add column if not exists description            text;
alter table projects add column if not exists collection_image_path text;  -- Supabase storage path (output bucket)
alter table projects add column if not exists collection_image_url  text;  -- IPFS URL after pinning
