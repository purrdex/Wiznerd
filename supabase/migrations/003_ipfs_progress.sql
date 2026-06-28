-- Wiznerd Platform — IPFS upload progress tracking
-- Run in the Supabase SQL editor after 002_project_persistence.sql

alter table projects add column if not exists ipfs_phase        text;           -- images | metadata | complete | error
alter table projects add column if not exists ipfs_images_done  integer default 0;
alter table projects add column if not exists ipfs_meta_done    integer default 0;
alter table projects add column if not exists ipfs_total        integer default 0;
alter table projects add column if not exists ipfs_current_file text;
alter table projects add column if not exists ipfs_error        text;
alter table projects add column if not exists ipfs_service      text;           -- Pinata | NFT.storage

-- Track per-token image CID so retries can skip already-uploaded images
alter table generated_tokens add column if not exists image_cid text;
