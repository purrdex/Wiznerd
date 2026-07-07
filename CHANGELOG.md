# Changelog

## v1.5.0 — 2026-07-06 (Social & Notifications)

### N1 — Watchlist / Favorites
- Heart button on every collection card in the browse grid — hover to reveal, always visible when favorited
- Heart button on collection detail page header — toggles inline
- New `/marketplace/watchlist` page — shows all favorited collections with live floor/volume data
- "Watchlist" added to nav (desktop links + mobile menu)
- Favorites persist in `favorites` table keyed by wallet address + collection ID
- Server: `GET /api/favorites`, `POST /api/favorites`, `DELETE /api/favorites/:type/:id`, `GET /api/favorites/collections`

### N2 — In-app notifications
- Bell icon in TopNav — shows red unread badge, polls every 60 seconds
- Dropdown lists up to 12 recent notifications with title, body, timestamp, and link
- "Mark all read" button clears the badge
- Notifications fire automatically on offer events:
  - Bid posted on your NFT → "New offer on [NFT name]"
  - Your listing sold (ask taken) → "[NFT name] sold!"
  - Your bid was accepted → "Your bid on [NFT] was accepted"
- Server: `GET /api/notifications`, `POST /api/notifications/read-all`, `POST /api/notifications/:id/read`
- DB: `supabase/migrations/024_social.sql` — notifications table with wallet_address, type, title, body, link_url, read

### N4 — User public profile
- New page `/marketplace/profile/:address` — public view of any wallet
- Shows avatar (initials), display name, bio, Twitter, website URL
- NFT gallery with click-through to collection+NFT modal
- Activity tab showing all on-chain events for that address
- Own wallet address gets an "Edit Profile" form (display_name, bio, twitter, website)
- Server: `GET /api/user-profile/:address`, `PUT /api/user-profile/:address`
- DB: `user_profiles` table in `024_social.sql`

### N6 — Cross-collection activity in Profile
- "Activity" tab added to `/marketplace/profile` (own wallet page) between "My NFTs" and "Collection Bids"
- Shows all on-chain sales, transfers, listings, and offers for the connected wallet
- Uses address filter on the global `/api/marketplace/activity` endpoint
- Load More pagination

### N7 — Toast notification queue
- New `ToastProvider` wrapping the entire app (in `main.tsx`)
- Stacked toast queue: up to 5 simultaneous toasts, 4-second auto-dismiss
- Three types: success (green), error (red), info (blue) — each with distinct left border and icon
- `useToast()` hook exportable across all marketplace pages
- Files: `src/components/ToastContext.tsx`, `src/components/ToastContext.css`

---

## v1.4.0 — 2026-07-06 (Creator Suite)

### C2 — Creator public profiles
- New page `/marketplace/creator/:address` showing all launched collections from a creator
- Header stats: collection count, total minted, total volume (XCH)
- Collection cards grid with supply bar and marketplace status badge
- Creator address on collection pages now links to `/marketplace/creator/:address` instead of the profile page
- Server: `GET /api/marketplace/creator/:address` aggregates projects + minted/volume totals

### C3 — Earnings dashboard
- Per-project "Manage" panel in the creator dashboard (appears on launched collections)
- Shows primary revenue in XCH and total minted count
- 30-day mint activity bar chart (recharts BarChart)
- Server: `GET /api/marketplace/:id/earnings` returns revenue and daily mint chart data

### C4 — Post-launch allowlist modifications
- "Manage ▼" button on each launched project card in the creator dashboard
- Inline allowlist textarea — edit live, save with one click
- Pre-populates from the saved allowlist when resuming a project in the wizard
- `PATCH /api/projects/:id` now accepts `allowlist` and `mints_paused` updates

### C6 — Creator verify/apply flow
- "Get Verified ✓" section in the Manage panel per launched collection
- Form: Twitter handle, website, brief authenticity note
- `POST /api/creator/verify-request` stores request in new `verify_requests` table
- Status shown inline after submission
- DB: `supabase/migrations/022_verify_requests.sql`

### C8 — Allowlist CSV validator with preview
- CSV/TXT upload on the allowlist step now shows a validation preview before merging
- Validates: must start with `xch1`, must be 62 chars, no duplicates
- Preview shows valid count (green), invalid rows with reason (red), truncated if > 10 invalid
- "Add N valid" button merges only the clean addresses; "Dismiss" discards the preview

### C9 — UTM referral tracking
- Collection pages fire a `POST /api/analytics/pageview` on mount when `?utm_source=` is present in the URL
- Referral breakdown shown in the Manage panel (30-day): counts per source
- Server: `GET /api/analytics/:id/referrals` — groups page_views by utm_source
- DB: `supabase/migrations/023_page_views.sql` — `page_views` table, 90-day auto-purge function

### DB migrations required
Run in Supabase SQL editor:
- `supabase/migrations/022_verify_requests.sql`
- `supabase/migrations/023_page_views.sql`

---

## v1.3.0 — 2026-07-06 (Trading Power)

### T3 — Offer expiration
- Expiry picker in offer creation panel: 1h / 6h / 24h / 7d / 30d / Never
- `expires_at` sent to server on both the "in-wallet" create-offer flow and the manual offer-string flow
- Expiry label shown next to each open offer in the NFT modal ("exp 6h ago", "expired")
- Background cron in `trending.js` marks expired `nft_offers` and `collection_bids` as `status='expired'` every 5 minutes
- Stats queries (`/collections/:id/stats`) now exclude expired offers from floor and listed counts

### T4 + T9 — Sweep + Cart
- **Cart context** (React Context + localStorage) shared across all marketplace pages
- **Cart icon** in TopNav with item-count badge (orange dot)
- **Cart drawer** slides in from the right: shows items with image/name/price, total XCH, Buy All checkout, Clear Cart
- **Checkout flow**: takes offers sequentially, shows per-item success/failure log; clears cart on full success
- **Sweep Floor** button appears in collection gallery header when `listed_count > 0` (external collections only)
- Sweep modal: item count slider (1–20), shows floor items with names/images/prices, "Add N to Cart" → opens cart drawer
- **Add to Cart** button (🛒) appears next to "Buy" on any ask offer in NFT detail modal
- New server endpoint: `GET /api/marketplace/:id/floor-items?limit=N` — cheapest N open asks with NFT metadata

### T6 — Bulk listing
- "Select" mode toggle in My NFTs profile tab — checkboxes appear on NFT cards
- "List X NFTs" button activates when ≥1 item selected
- Bulk list modal: single price input + expiry picker; calls `create-offer` sequentially for each NFT
- Progress counter shows `X/N listed` with inline error if any fail

### T1 — Collection offers
- "Collection Offers" section on external collection pages showing open bids from any wallet
- "Make Offer" button for non-owners: price (XCH) + optional expiry → stored in `collection_bids` table
- Bid owner can cancel their own bid
- "Collection Bids" tab in My NFTs profile: shows all open collection bids for collections you hold NFTs in, with collection name + thumbnail + "View Collection →"
- New server endpoints: `GET/POST /api/marketplace/:id/collection-bids`, `DELETE /api/marketplace/collection-bids/:id`, `GET /api/marketplace/collection-bids/for-owner/:address`

### T10 — (deferred to v1.3.1)
CAT balance validation was deprioritised; the wallet daemon balance check requires an extra round-trip and the UI change is minor. Tracked as T10.

### DB migration required
Run `supabase/migrations/021_collection_bids.sql` in the Supabase SQL editor to create the `collection_bids` table.

---

## v1.2.0 — 2026-07-06 (Rankings, Activity Feed, Floor History)

### Rankings page (`/marketplace/rankings`)
- New full-page rankings table: rank #, collection thumb + name + verified badge, floor, 24h vol, 7d vol, 24h sales, 7d sales, listed count, supply
- Sort controls: 7d Volume (default), 24h Volume, Floor Price, Trending Score, 7d Sales
- Click any row to navigate to the collection
- Server: `GET /api/marketplace/rankings?sort=...&limit=100` backed by `indexed_collections` + real-time trending data
- TopNav: "Rankings" link added (active state detection)

### Global Activity feed (`/marketplace/activity`)
- Cross-collection activity feed showing sales, transfers, listings, and offers
- Filter tabs: All / Sales / Transfers / Listings / Offers
- Each row: NFT thumbnail, NFT name, collection link, event type (color-coded), price, from→to addresses, time
- Load More pagination (`hasMore` flag, `?offset=` query param)
- Server: `GET /api/marketplace/activity?type=...&offset=...` backed by `nft_events` table
- TopNav: "Activity" link added

### Floor price history chart (Collection page)
- Hourly cron in `trending.js` snapshots floor prices into new `floor_snapshots` table
- Collection stats section shows a 64px cyan AreaChart (recharts) when ≥ 2 snapshots exist
- 30-day % change indicator shown next to "Floor — 30d" label (green/red)
- Server: `GET /api/marketplace/:id/floor-history?days=30`
- DB: `supabase/migrations/020_floor_snapshots.sql` — creates table, index, 90-day purge function

### Notable Sales section (Homepage)
- Horizontal scroll row on the "All" tab (no search) showing top 8 sales by price in last 7 days
- Each card: NFT image, name, collection name, price in XCH
- Server: `GET /api/marketplace/notable-sales?days=7&limit=10`

### Recently Active section (Homepage)
- Horizontal scroll row showing up to 8 external collections sorted by recent activity
- Links to Rankings page for full list

### NFT history expand toggle (Collection page)
- NFT event history previously capped at 5 entries with no way to see more
- "View all N" / "Show less" toggle button replaces the hard slice
- `historyExpanded` resets to false when a different NFT is selected

### 7d volume on browse cards
- Non-trending external collection cards now show `X XCH 7d vol` when `volume_7d_mojo > 0`

### DB Migration required
Run `supabase/migrations/020_floor_snapshots.sql` in the Supabase SQL editor, then restart `server/index.js` to activate the hourly floor snapshot cron.

---

## v1.1.0 — 2026-07-06 (Bug Fixes)

### BUG-1 — Manage dashboard error state wired up
- `error` state in `Manage.tsx` was declared but never set or displayed
- `togglePause` and `handleReveal` now catch errors and surface them in the existing `mp-error-box` element
- Error is cleared on each new action attempt

### BUG-2 — Profile "Listed" badge now works
- `/api/marketplace/offers/board?nft_ids=...` now accepts a comma-separated NFT ID list and returns only those with active asks
- Profile page listing check uses this lightweight endpoint; "Listed" badge appears correctly on owned NFTs that have open asks

### BUG-3 — Trait filter pills visually disabled when not indexed
- `.mp-trait-pill.info-only` was missing CSS — pills had `cursor:pointer` and hover styles even though clicking did nothing
- Added `pointer-events: none; opacity: 0.5; cursor: default` and overrode hover to make the inactive state unambiguous

### BUG-4 — Activity tab paginated (Load More)
- Activity endpoint hard-capped at 50 events with no way to load more
- Server: added `?offset=` query param; response shape is now `{ events: [], hasMore: boolean }`; old array response still accepted client-side for backwards compatibility
- Frontend: "Load More" button appears when `hasMore: true`; appends to existing list; spinner replaces button while loading

### BUG-5 — Wallet connect prompt in NFT modal
- Without a wallet address in localStorage, Buy/List/Make Offer buttons rendered but silently failed when clicked
- NFT modal action area now shows "Open the wallet to buy, list, or make offers" + "Open Wallet" button (opens `/` in new tab) when no wallet is connected

### Backend
- `trending.js`: score formula now uses 7-day daily average as fallback when `sales_24h = 0`; eliminates "0 with score > 0" when there's no same-day activity
- `trending.js`: `sales7d` added as parameter to `computeScore` (was computed but never passed in)
- `marketplace.js`: traits endpoint returns `{ filterable: boolean, traits: {} }` instead of bare object; cache TTL is 2 min when `filterable: false` (backfill in progress) vs 30 min when fully indexed
- `marketplace.js`: `isIndexed` in `Collection.tsx` now uses `traitsFilterable` from the explicit server flag instead of inferring from gallery items' trait presence

---

## v1.4.0 — 2026-07-02 (Quick Wins: Polish & Discovery)

### QW1 — Verified badges
- Blue ✓ badge on browse cards for verified collections (`verified` column in `indexed_collections`)

### QW2 — Per-trait rarity % in NFT modal
- Each trait chip now shows rarity percentage (e.g. "Background: Forest — 12.3%"), calculated from collection-wide trait counts vs indexed supply

### QW3 — Sort dropdown on collection gallery
- "Token order" and "Rarity: rarest first" options; sort propagated server-side so pagination stays consistent

### QW4 — Grid size toggle (large / compact)
- Large/compact toggle on gallery header; preference persisted in `localStorage`
- Compact mode: smaller tiles, hidden hover-traits, tighter gap

### QW5 — Creator address links to profile
- Creator address in collection header is now a clickable link to `/marketplace/profile?address=...`

### QW6 — Listed count on browse cards
- Active asks per collection aggregated in trending job and surfaced on browse cards ("X listed")
- Migration `019_listed_count.sql`: adds `listed_count` column to `indexed_collections`

### QW7 — Allowlist CSV upload in creator wizard
- "Upload CSV" button in step 8 parses xch1 addresses from any CSV/TXT file and merges into the allowlist textarea; deduplicates on import

### QW8 — Revenue sparkline in creator dashboard
- 30-day daily revenue area chart (recharts AreaChart) above the orders table; computed client-side from existing orders state

### QW9 — Wallet-agnostic USP copy on mint panel
- "No browser extension needed — works with any Chia wallet · Sage · Chia Light · Nucle · CLI" added below QR code

### QW10 — Floor price delta indicator
- Floor stat shows ↑/↓ % vs 7-day average sale price when meaningful (>1% delta); computed from existing `collStats.volume_7d_mojo / sales_7d`

### Backend
- Gallery endpoint: returns `rarity_rank` per item; accepts `?sort=rarity` param
- Trending job: aggregates `listed_count` per collection from `nft_offers → indexed_nfts`
- External browse API: exposes `listed_count` and `verified`

---

## v1.3.0 — 2026-07-01 (Trending, Dexie Backfill, Multi-Token Offers)
- feat: Dexie volume backfill (`server/dexie-backfill.js`) — 355k trades across 1000+ collections
- feat: Trending score job (`server/trending.js`) — 15-min background job; score = vol24h × √(1+acceleration) × log(1+sales24h)
- feat: Multi-token offers — CAT wallet picker in offer panel; `nft_offers`/`nft_transfers` support non-XCH tokens
- feat: Marketplace All page sorted: trending → live minting → minted_count
- fix: Paginated `fetchVolume()` removes Supabase 1000-row cap on stats
- fix: Partial unique index → full unique index for PostgREST upsert compatibility (migration 016)
- fix: `mint_24h` excluded from trending score (was inflating counts via re-indexing)
- fix: Watcher retry loop capped at 5 attempts; bogus orders auto-cancelled; skipped coins logged once

---

## v1.0.0 — 2026-06-28 (Marketplace & Minting Engine)

### Features
- **Launch Step** (wizard step 8): mint price input, launch timing (immediate or scheduled), allowlist textarea, instant/blind reveal toggle, Publish Collection button — redirects to `/marketplace/:id/manage`
- **Marketplace Browse** (`/marketplace`): grid of published collections, filter tabs (All / Live Now / Upcoming / Sold Out), search, live countdown timers, supply progress bars, XCH + USD prices
- **Collection Mint Page** (`/marketplace/:id`): hero image, supply stats with Supabase Realtime counter, countdown timer, allowlist badge, MINT button → unique XCH payment address + QR code, live order status polling, minting spinner, NFT reveal on confirmation, gallery of recently minted tokens, blind-mint placeholder support
- **Creator Management Dashboard** (`/marketplace/:id/manage`): live stats (mints today, total minted, remaining, revenue XCH + USD), pause/resume toggle, blind-mint reveal button, manual gift mint, orders table with status pills, CSV export
- **Minting Engine**: `server/mint.js` — BullMQ `mint` worker, calls `nft_mint_nft` via wallet daemon, optimistic token reservation (SELECT FOR UPDATE equivalent), sold-out detection
- **Payment Watcher**: `server/watcher.js` — polls Chia full node every 10s via `get_coin_records_by_puzzle_hash`, bech32m address → puzzle hash, dispatches mint on payment detected
- **Supabase Realtime**: live supply counter on collection page, live order updates on management dashboard

### Database
- Migration `004_marketplace.sql`: `mint_price_mojo`, `launch_at`, `allowlist`, `reveal_type`, `marketplace_status`, `mints_paused` added to `projects`; `orders` table with RLS policies

### Backend
- `server/marketplace.js`: all `/api/marketplace/*` routes
- `server/watcher.js`: payment detection daemon started on server boot
- `server/mint.js`: NFT minting via wallet daemon with token locking

---

## v0.14.0 — 2026-06-28 (Generative Art Engine)
- feat: `supabase/migrations/001_initial.sql` — full schema: projects, layers, variants, incompatibilities, generated_tokens with RLS + realtime notes
- feat: `server/index.js` — Express API server on port 3002 with full CORS allowlist; 8 routes: create project, upload layers, save variants/weights/incompatibilities, preview (5 samples), generate (BullMQ queue or synchronous fallback), status, rarity report, IPFS pin
- feat: `server/generation.js` — Hashlips-style weighted trait selection with incompatibility checking, uniqueness enforcement, `@napi-rs/canvas` image compositing (prebuilt Windows x64 binaries), Supabase Storage upload, per-token DB records, live progress updates
- feat: `server/ipfs.js` — NFT.storage HTTP API upload of all images + CHIP-0007 metadata JSON per token; updates token records with `ipfs://` URIs
- feat: `src/create/index.tsx` — 8-step creator wizard: New Project → Layer Upload → Trait Config (weights + incompatibility rules) → Preview (5 samples) → Generate (Realtime progress via Supabase channel + polling fallback) → Rarity Report (recharts BarChart per layer) → IPFS Pin → Launch link
- feat: `src/lib/supabase.ts` — Supabase frontend client from `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`
- feat: `.env` updated with `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_URL` for Vite frontend exposure
- infra: BullMQ + ioredis queue with graceful degradation (runs synchronously when Redis unavailable)
- infra: `@napi-rs/canvas` replaces `node-canvas` for Windows-compatible prebuilt binaries
- infra: `server/` directory added to repo with own `package.json`; output images excluded from git

## v0.13.0 — 2026-06-27 (Platform Restructure)
- refactor: installed react-router-dom; set up `createBrowserRouter` in `src/main.tsx`
- refactor: moved wallet code from `src/` to `src/wallet/`; `src/lib/*` to `src/wallet/lib/*`
- feat: routes: `/` → WalletApp, `/create` → CreateScreen (placeholder), `/marketplace` → MarketplaceScreen (placeholder)

## v0.12.0 — 2026-06-27 (Security Hardening & Polish)
- fix: CORS wildcard replaced with origin-allowlist in chia-proxy — localhost always allowed; production origins via `FRONTEND_ORIGIN` env var; `Vary: Origin` header set
- fix: Change Password now verifies current password before re-encrypting — decrypts one wallet with re-derived key before any state changes; errors clearly as "incorrect password"
- fix: Salt race condition in Change Password — `generateSalt()` and `storeSalt()` split; salt only committed to localStorage after all wallets successfully re-encrypted
- fix: Mixed-content warning in Settings — shown when app is on HTTPS but proxy URL is HTTP
- fix: HistoryScreen state reset on deps change — `setEvents([])`, `setError('')`, `setLoading(true)` at effect start prevents stale history on wallet/node switch
- fix: Local proxy option now selectable from node dropdown — sentinel value `__local__` clears the custom URL field instead of being excluded from the list
- ux: Proxy URL test button in Settings — fetches `/price/xch` with 5s timeout, shows latency or error inline
- ux: In-app transaction confirmation toast — slides up from bottom nav, auto-dismisses after 4s; fires on `pollConfirmation` success
- ux: Password strength indicator on wallet creation and Change Password — animated bar: Weak / Fair / Strong with color feedback
- ux: Seed phrase backup reminder banner — shows on first wallet creation, dismissible, persisted to localStorage
- test: Forgot Password wipe-and-restore flow — verifies lock screen → wipe → setup screen + localStorage cleared
- test: Change Password wrong-password rejection — verifies `error-msg` appears with "incorrect" text when current password is wrong

## v0.11.0 — 2026-06-27 (Bug Fixes & Web Deployment)
- fix: HistoryScreen `useEffect` now re-runs on wallet switch and nodeUrl change — history reloads correctly when switching wallets or configuring a node mid-session
- fix: SetupScreen 'password' mode adds Back button — user can return to quiz (new wallet) or import form
- fix: LockScreen Forgot Password recovery path — "Restore from seed phrase" link with wipe-and-restore confirmation; prevents users from being permanently locked out
- refactor: removed orphaned `sendXch` / `selectCoins` from spend.ts — XCH send path now uses `walletRpc` directly like clawback; proxy URL unified
- fix: proxy full-node RPC route adds 20s timeout matching the wallet daemon route
- feat: Change Password in Settings — re-derives key, re-encrypts all wallets with new salt; takes effect immediately for the session
- feat: Idle auto-lock — configurable inactivity timeout (5/15/30/60 min / never); tracks mouse, keyboard, click, touch events
- ux: removed redundant "Your Address" card from WalletHome — balance card → Assets without the copy row
- feat: Proxy URL configurable in Settings — stored in localStorage; overrides `VITE_PROXY_URL`; `cats.ts` and `walletRpc` both read it dynamically
- feat: Public Chia node dropdown in Settings — quick-select SpeedFarmer, Chia Official, or type custom URL
- feat: Vercel/Netlify deploy config — `vercel.json` and `netlify.toml` with SPA rewrites and security headers
- feat: `.env.example` checked in — documents `VITE_PROXY_URL` for production deployments

## v0.10.0 — 2026-06-27 (Portfolio, Polish & Security)
- feat: Password-derived mnemonic encryption — PBKDF2 (600k iterations) + AES-256-GCM via Web Crypto API; mnemonics never stored in plaintext; existing wallets forced through one-time migration to set a password; password re-prompted on each page reload (MetaMask pattern)
- feat: Total portfolio USD value — XCH + all priced CAT holdings summed to a single fiat total in the balance card; visible whenever at least one CAT has a known price
- feat: Coin consolidation / UTXO merge — "Consolidate coins" action in WalletHome sends full XCH balance back to primary address, forcing daemon to merge all UTXOs; configurable fee
- fix: ReceiveScreen address cap — "Show more" now reveals all 50 derived addresses instead of capping at 20
- fix: `calculateCoinId` concurrency — replaced unbounded `Promise.all` with `mapConcurrent(items, 20)` in HistoryScreen; prevents event-loop stall on 200+ coin wallets

## v0.9.0 — 2026-06-27 (Security & Critical Fixes)
- feat: Hot wallet security banner — persistent unencrypted-storage warning with per-session dismiss
- feat: Reveal seed phrase in Settings — show/hide/copy mnemonic after wallet creation (like MetaMask's "Reveal SRP")
- feat: Seed phrase verification quiz — require re-entering 3 random words before opening a new wallet; wrong answers blocked with clear error
- fix: BigInt-safe `walletRpc` serializer — all wallet daemon calls now emit raw integer literals via custom JSON serializer; no more `Number(bigint)` precision loss above ~9,007 XCH
- fix: `formatMojoToXch` precision — replaced `Number(mojo)/1e12` with pure BigInt arithmetic; all balance displays correct at any amount
- fix: Clawback and Offers screens use native bigint amounts — `Number()` casts removed from all `walletRpc` calls in `SendScreen` and `OffersScreen`
- fix: Stale `balance` closure in `WalletHome.fetchAll` — replaced stale-state guard with a `hasLoadedRef`; no more spurious "Cannot reach proxy" on transient failures
- fix: `localStorage` cache size caps — `puzzleCache` capped at 500 entries, `phAssetCache` at 2000; oldest entries evicted to prevent silent `setItem` failure and cache divergence
- test: 3 new Playwright tests — quiz appears after confirm, quiz rejects wrong words, Settings reveals seed phrase (15 tests total)

## v0.8.0 — 2026-06-27 (On-Chain Trading & History)
- feat: Take offer — paste an `offer1…` string, decode terms, one-tap atomic settlement via wallet daemon
- feat: Create offer — build XCH↔CAT offer strings, copy or submit to Dexie
- feat: Clawback sends — optional 10min/1hr/24hr recall window on XCH sends; pending rows in history with Recall button
- feat: Transaction detail — tap any history row to expand block, mojo amount, coin ID, Spacescan link
- fix: CAT history gap — fully-spent tokens now labelled via `phAssetCache` + `getTokenMetadata` fallback
- feat: Pending mempool transactions — submitted sends appear as "Pending" in history until confirmed or expired
- test: HistoryScreen — no-node empty state and scanning state with configured node (2 new tests, 12 total)

## v0.1.0 — 2026-06-25 (Initial Build)
- feat: Mnemonic import and wallet creation
- feat: BLS key derivation (verified against Chia reference)
- feat: XCH balance with USD price via Gate.io
- feat: CAT token discovery via on-chain hints
- feat: Token metadata from Dexie (926 tokens)
- feat: Token logos from icons.dexie.space
- feat: CAT token prices from Dexie offers API
- feat: Send XCH via wallet daemon
- feat: NFT display — grid + detail, PNG and MP4 support
- feat: NFT transfer with royalty display
- feat: Receive addresses (expandable)
- feat: Settings — node config, sync status
- feat: Wiznerd Wallet branding, dark theme, mobile-first