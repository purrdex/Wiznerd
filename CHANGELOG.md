# Changelog

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