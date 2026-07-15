CREATE TABLE IF NOT EXISTS launched_tokens (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id            text,
  name                text        NOT NULL,
  symbol              text        NOT NULL,
  description         text,
  image_url           text,
  total_supply        bigint      NOT NULL,
  xch_liquidity       bigint      NOT NULL,
  cat_liquidity       bigint      NOT NULL,
  creator_address     text        NOT NULL,
  payment_address     text        NOT NULL,
  payment_amount      bigint      NOT NULL,
  pair_coin_id        text,
  status              text        NOT NULL DEFAULT 'pending',
  error_message       text,
  spacescan_submitted boolean     DEFAULT false,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_launched_tokens_status     ON launched_tokens (status);
CREATE INDEX IF NOT EXISTS idx_launched_tokens_creator    ON launched_tokens (creator_address);
CREATE INDEX IF NOT EXISTS idx_launched_tokens_asset      ON launched_tokens (asset_id);

ALTER TABLE launched_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON launched_tokens FOR ALL TO service_role USING (true);
CREATE POLICY "anon_read"        ON launched_tokens FOR SELECT TO anon USING (true);
