# Changelog

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