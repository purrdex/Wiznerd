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

## v0.5.0 — CAT Sends (No Daemon Required)
Build: clean (475 KB / 138 KB gzip, no warnings). Tests: 6/6 pass. Findings sorted by user impact.

- [x] [FEAT] CAT sends without wallet daemon registration — build CAT spend bundles manually using the CAT outer puzzle wrapper. Research Chia CAT2 spend bundle format from chia-blockchain source. The wallet daemon cat_spend should be attempted first (for registered tokens), with manual spend bundle construction as fallback for unregistered tokens. This is the critical path item — every other wallet (Sage, MetaMask equivalent) lets users send any token without pre-registration.
- [x] [BUG] `BigInt(NaN)` render crash in `CatDetailScreen` and `SendScreen` — if a non-numeric value reaches the amount state (paste, autofill edge case), `BigInt(Math.round(NaN))` throws a TypeError and crashes the component mid-render; guard with `isNaN()` check before the `BigInt()` call (App.tsx:586–587, 1216–1217) — S effort
- [x] [BUG] CAT sends are absent from transaction history — `HistoryScreen` hardcodes `wallet_id: 1` and only fetches XCH transactions; CAT sends (type=6) in their daemon wallet IDs are invisible to the user (App.tsx:1098) — M effort
- [x] [BUG] `CatDetailScreen` shows stale balance after a successful send — `onSendSuccess()` triggers a `catBalances` refresh in `WalletHome`, but `CatDetailScreen` still renders the original `token` prop; user sees the pre-send balance until they navigate back and re-tap (App.tsx:566) — S effort
- [x] [BUG] NFT transfer fee uses `Number(feeMojo)` — same precision-loss pattern fixed in `sendXch`; loses integer precision for fees above ~9 XCH; inconsistent with the established bigint-safe body serialization (App.tsx:834) — S effort
- [x] [BUG] Proxy has no timeout on wallet daemon HTTPS requests — if the wallet daemon hangs (e.g. during sync), the proxy `/wallet/:endpoint` handler never resolves; the frontend AbortSignal fires but the upstream connection is never cleaned up, leaking the request (chia-proxy/index.js:231–249) — S effort
- [x] [UX] CAT send form has no address book picker — `SendScreen` (XCH) has an address book dropdown; `CatDetailScreen` doesn't; users sending CATs to the same exchange address repeatedly have no shortcut (App.tsx:630–752) — S effort
- [x] [UX] No error shown when proxy is offline — `WalletHome` and `SendScreen` catch fetch errors silently (`catch { /* silent */ }`); if `localhost:3001` is down the UI shows spinners indefinitely with no actionable message (App.tsx:201, 1208) — S effort
- [x] [UX] Mnemonic backup screen has no copy-to-clipboard button — users must manually transcribe all 24 words; a copy button (with a "never share" warning) reduces setup errors for users archiving to a password manager (App.tsx:113–137) — S effort
- [x] [PERF] `getCatWalletId` calls `get_wallets` on every `CatDetailScreen` mount with no caching — opening multiple token detail screens in a session fires a fresh daemon round-trip each time; a module-level TTL cache (30 s) on the wallets list would eliminate redundant calls (App.tsx:550–558) — S effort
- [x] [PERF] CAT coin discovery re-scans all 20 puzzle hashes on every 30 s refresh — `getCatBalances` calls `getPuzzleAndSolution` for every unspent CAT coin on every cycle; assetId lookup results could be cached by coinId in sessionStorage so only new coins are resolved (cats.ts:166–207) — M effort
- [x] [TEST] Playwright wallet-state tests silently skip in a fresh CI environment — all tests after "setup screen" are guarded by `if (hasWallet)` with no `expect()` when the wallet is absent; a fresh runner always shows 6 passing tests even when all wallet-specific assertions never executed (tests/wallet.spec.ts) — M effort
- [x] [TEST] No coverage for wallet creation or mnemonic import — the most security-critical paths (BIP39 validation, key derivation, address generation) have zero automated tests — M effort
- [ ] [TEST] No test for `CatDetailScreen` — opening a token detail view, verifying the wallet daemon status check, and send form validation are entirely untested — S effort

## v0.6.0 — Power Features
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