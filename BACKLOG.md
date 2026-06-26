# Wiznerd Wallet Backlog

## v0.2.0 — Polish & Core UX
- [x] Balance refreshes on home screen after successful XCH send
- [x] Address validation using bech32m checksum (not just length)
- [x] Show transaction pending state after send (spinner until confirmed)
- [x] Copy NFT ID button on detail view
- [x] QR code display on Receive screen

## v0.3.0 — History & Book
- [x] Transaction history screen (last 20 sends/receives)
- [x] Address book (save/label frequently used addresses)
- [x] Send screen: pick from address book

## v0.4.0 — CAT Sends
- [x] Detect CAT wallet IDs from wallet daemon get_wallets
- [x] CAT send flow (cat_spend RPC)
- [x] CAT token detail screen with send button

## v0.5.0 — Power Features
- [ ] Multiple wallet support (switch between mnemonics)
- [ ] Node connection indicator with latency
- [ ] Settings: toggle showing/hiding small balances
- [ ] Dark/light mode toggle

## vNext — Analysis Findings
Build: clean (1 chunk-size warning — 558 KB bundle). Tests: 6/6 pass. Findings sorted by user impact.

- [x] [BUG] History screen shows sent/received backwards — Chia `TransactionType.INCOMING_TX = 1`, `OUTGOING_TX = 2`; current check `type === 1 || type === 5` labels received XCH as "Sent" and vice versa (App.tsx:860) — S effort
- [x] [BUG] NFT transfer hardcodes `wallet_id: 2` — users with CAT wallets installed will have NFT wallets at IDs 3+; transfer call silently fails or hits wrong wallet (App.tsx:577) — S effort
- [x] [BUG] Wallet reset (`handleReset`) does not remove address book from localStorage — ADDRESS_BOOK_KEY entries from the removed wallet persist for whoever sets up next (App.tsx:1165) — S effort
- [x] [BUG] `sendXch` casts `amountMojo` and `feeMojo` to `Number()` — JS Number loses integer precision above ~9,007 XCH (53-bit mantissa ÷ 1e12 mojo); wallet daemon receives wrong mojo count for large sends (spend.ts:38) — S effort
- [x] [BUG] `TokenAvatar` `onError` hides the failed logo `<img>` with `display:none` but renders no fallback; token row shows blank space instead of initials circle (App.tsx:475) — S effort
- [x] [BUG] `getPuzzleAndSolution` height analysis — FALSE POSITIVE: in Chia's UTXO model a child coin is created in the same block its parent is spent, so `confirmed_block_index` of the child equals the parent's spent height; code is correct (cats.ts:163)
- [x] [UX] No "Max" button on Send screen — users must mentally subtract fee from balance to send full amount; standard wallet affordance (App.tsx:SendScreen) — S effort
- [x] [UX] Transaction history capped at 20 with no "Load more" — power users cannot view older transactions (App.tsx:839) — M effort
- [x] [UX] `window.confirm()` used for wallet removal dialog — unstyled browser-native dialog clashes with dark custom theme (App.tsx:454) — S effort
- [x] [UX] No block explorer link on transaction history rows — users cannot verify or drill into a transaction without leaving the wallet manually — S effort
- [x] [UX] Balance card displays raw mojo count (e.g. "2,000,000,000,000 mojo") below XCH amount — noisy for end users; remove or hide behind a tap (App.tsx:229) — S effort
- [x] [PERF] BLS12-381 library bloats the bundle to 558 KB (174 KB gzip); build already warns about size — dynamic `import()` of keys.ts at wallet-unlock time would drop the initial page load significantly (vite.config.ts, keys.ts) — M effort
  — Result: initial 174→137 KB gzip; BLS chunk (39 KB gzip) loads only at wallet setup/restore; chunk-size build warning eliminated; hexToBytes/bytesToHex/formatMojoToXch/isValidXchAddress extracted to utils.ts to break cats.ts→keys.ts static chain
- [x] [PERF] NFT metadata requests all fire in parallel (up to 50 at once via `Promise.all`) — IPFS gateways rate-limit concurrent requests; add a concurrency limiter (e.g. 5 at a time) (App.tsx:746) — S effort
- [x] [PERF] Token metadata cache (`metadataCache` in cats.ts) is module-level in-memory only — cleared on every page reload; persisting to `sessionStorage` would eliminate repeated Dexie/taildatabase queries within a session (cats.ts:88) — S effort
- [ ] [FEAT] Proxy XCH price guard `price < 100` will silently drop real prices if XCH ever exceeds $100 — raise the cap or remove it (proxy/index.js:175) — S effort