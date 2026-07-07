-- ── v1.5 Social & Notifications ──────────────────────────────────────────────

-- Favorites: users heart collections and NFTs
CREATE TABLE favorites (
  id             uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  wallet_address text        NOT NULL,
  item_type      text        NOT NULL CHECK (item_type IN ('collection', 'nft')),
  item_id        text        NOT NULL,
  created_at     timestamptz DEFAULT now(),
  UNIQUE (wallet_address, item_type, item_id)
);
CREATE INDEX idx_favorites_wallet ON favorites (wallet_address);
CREATE INDEX idx_favorites_item   ON favorites (item_type, item_id);
GRANT ALL ON TABLE favorites TO postgres, service_role, authenticated, anon;

-- User profiles: editable display name, bio, social handles
CREATE TABLE user_profiles (
  address        text        PRIMARY KEY,
  display_name   text,
  bio            text,
  twitter_handle text,
  website_url    text,
  updated_at     timestamptz DEFAULT now()
);
GRANT ALL ON TABLE user_profiles TO postgres, service_role, authenticated, anon;

-- Notifications: in-app alerts for offer / sale events
CREATE TABLE notifications (
  id             uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  wallet_address text        NOT NULL,
  type           text        NOT NULL,  -- offer_received | offer_taken | mint_confirmed
  title          text        NOT NULL,
  body           text,
  link_url       text,
  read           boolean     DEFAULT false,
  created_at     timestamptz DEFAULT now()
);
CREATE INDEX idx_notifications_wallet ON notifications (wallet_address, created_at DESC);
CREATE INDEX idx_notifications_unread ON notifications (wallet_address, read) WHERE read = false;
GRANT ALL ON TABLE notifications TO postgres, service_role, authenticated, anon;
