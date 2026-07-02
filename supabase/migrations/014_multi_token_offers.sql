-- Multi-token offer support: allow NFT offers priced in any CAT token

alter table nft_offers
  add column if not exists price_token text not null default 'xch',
  -- price_mojo repurposed: raw token amount in the token's base unit
  -- (mojos for XCH; raw CAT mojos for CAT tokens)
  alter column price_mojo drop not null;

alter table nft_transfers
  add column if not exists price_token text default 'xch';

create index if not exists idx_nft_offers_token on nft_offers(price_token, status);
