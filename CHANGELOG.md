# Changelog

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