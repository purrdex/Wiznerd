-- Collection-level bids: any holder of an NFT in the collection can accept
-- (offer expiry column on nft_offers is already present from the server schema;
--  the column was added when the offers endpoints were built — this migration
--  only adds the new collection_bids table.)

CREATE TABLE IF NOT EXISTS collection_bids (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id  text        NOT NULL,
  bidder_address text        NOT NULL,
  price_mojo     bigint      NOT NULL,
  price_token    text        NOT NULL DEFAULT 'xch',
  status         text        NOT NULL DEFAULT 'open'
                               CHECK (status IN ('open', 'accepted', 'cancelled', 'expired')),
  expires_at     timestamptz,
  accepted_nft_id text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collection_bids_col
  ON collection_bids (collection_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS collection_bids_bidder
  ON collection_bids (bidder_address, status, created_at DESC);

-- Grant access to PostgREST roles
GRANT ALL ON TABLE collection_bids TO postgres, service_role, authenticated, anon;

-- Auto-expire collection bids older than 30 days that have no explicit expires_at
CREATE OR REPLACE FUNCTION expire_old_collection_bids() RETURNS void LANGUAGE sql AS $$
  UPDATE collection_bids
  SET status = 'expired'
  WHERE status = 'open'
    AND (
      (expires_at IS NOT NULL AND expires_at < now())
      OR (expires_at IS NULL AND created_at < now() - interval '30 days')
    );
$$;
