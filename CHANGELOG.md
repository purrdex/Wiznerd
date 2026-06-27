# Changelog

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