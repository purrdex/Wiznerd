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
Build: clean (479 KB / 139 KB gzip, no warnings). Tests: 10/10 pass. All items complete.

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
- [x] [TEST] No test for `CatDetailScreen` — opening a token detail view, verifying the wallet daemon status check, and send form validation are entirely untested — S effort

## v0.6.0 — Power Features
- [x] Multiple wallet support (switch between mnemonics)
- [x] Node connection indicator with latency
- [x] Settings: toggle showing/hiding small balances
- [x] Dark/light mode toggle

## v0.7.0 — History Rebuilt
Theme: make transaction history work entirely from the full node — no wallet daemon required.
Manual CAT sends become visible. XCH history becomes reliable regardless of daemon state.

- [x] [BUG] History requires wallet daemon — shows nothing when daemon absent or unregistered; rebuild using `get_coin_records_by_puzzle_hashes(include_spent=true)`; compute coin IDs to strip change outputs; group spent coins by block for net-sent amounts — M effort
- [x] [BUG] Manual CAT sends invisible — `get_transactions` knows nothing about `push_tx` sends; add CAT history via `get_coin_records_by_hint(include_spent=true)` for all inner puzzle hashes; use `catBalances.coins[].puzzleHash` to resolve assetId/ticker — M effort
- [x] [FEAT] Remove proxy XCH price cap `price < 100` — silently drops real prices if XCH ever exceeds $100 (proxy/index.js:175) — S effort
- [x] [UX] History: show load-more — full-node scan can find many events; cap initial render at 50, paginate — S effort
- [ ] [TEST] Playwright test for HistoryScreen: verify renders without daemon, shows empty state when no node configured — S effort

## v0.8.0 — On-Chain Trading (Offers)
Theme: implement Chia's offer file protocol — the ecosystem's native DEX primitive. Trade any
XCH/CAT pair peer-to-peer, atomically, without leaving the wallet or trusting a centralized
exchange. Every serious Chia wallet has offers; without them users must go to an external site
to trade. Dexie is just an aggregator of offer strings — we can participate.

- [x] [FEAT] Take offer — paste an `offer1…` string; decode terms (you give X / you receive Y), show royalty info for NFT legs, one tap to complete and submit via `push_tx`. Atomic settlement in one block, no counterparty risk. XCH↔CAT pairs first, NFT legs in a follow-up. — L effort
- [x] [FEAT] Create offer — pick asset + amount to offer, pick asset + amount to request; lock the offered coins with the SETTLEMENT_PAYMENTS puzzle and output the offer string. Copy to clipboard + one-tap submit to Dexie. XCH↔CAT. — L effort
- [x] [FEAT] Clawback sends — send XCH with a user-chosen timelock (10 min / 1 hr / 24 hr); history shows a "Clawback pending — Cancel" row during the window. Matches Chia Cloud Wallet's headline safety feature, low implementation cost relative to user value. — M effort
- [x] [UX] Transaction detail screen — tap any history row to expand: full mojo amount, block height, coin IDs, spacescan link, fee (where derivable from change). Currently the row is the whole story. — S effort
- [x] [BUG] CAT history gap for fully-spent tokens — tokens received and fully sent are absent from `catBalances`, so hint-found spent coin records can't be labelled; need outer-puzzle-hash → assetId lookup via the existing `phAssetCache` for coins not in active balances. — M effort
- [x] [UX] Pending/mempool transactions in history — history only shows confirmed coin records; track recently submitted spend bundles in sessionStorage, show as "Pending" until a matching confirmed record appears on the next poll. — M effort
- [x] [TEST] Playwright test for HistoryScreen — verify no-node empty state and "Scanning chain…" loading state (carried from v0.7.0). — S effort

## v0.10.0 — Portfolio, Polish & Security

- [x] [SECURITY] Password-derived mnemonic encryption — Web Crypto API, PBKDF2 key derivation, AES-256-GCM encryption. Prompt for password on first wallet creation and on each new session unlock. Mnemonic never stored in plaintext. MetaMask pattern. — L effort
- [x] [FEAT] Total portfolio USD value across all assets on home screen — XCH + all CAT holdings summed to single fiat total — S effort
- [x] [FEAT] Coin consolidation / UTXO merge — send all coins to own address with fee; resolves "no single CAT coin covers this send" dead-end — M effort
- [x] [BUG] ReceiveScreen address cap fix — "Show more" uses `slice(0, 20)` but should show all 50 derived addresses — S effort
- [x] [PERF] `calculateCoinId` concurrency limit in HistoryScreen — currently fires unlimited parallel digest calls; stalls on 200+ coins — S effort

## v0.9.0 — Security & Critical Fixes

- [x] [SECURITY] All wallet mnemonics stored in plaintext in `localStorage['chia_wallets']` — any JS in the same origin (browser extension, injected script, XSS) can read every mnemonic; add persistent banner warning this is an unencrypted hot wallet — L effort
- [x] [SECURITY] `puzzleCache` and `phAssetCache` in `localStorage` grow unbounded with no TTL or size cap — silent `setItem` failure once storage fills causes cache/memory divergence and repeated RPC calls — M effort
- [x] [BUG] `formatMojoToXch` coerces BigInt through `Number()` before dividing — `Number(mojo) / 1_000_000_000_000` loses precision above ~9,007 XCH; affects every balance display and history row (utils.ts) — S effort
- [x] [BUG] Clawback send path passes `Number(amountMojo)` / `Number(feeMojo)` to `walletRpc` — same precision-loss pattern fixed for regular sends; wrong mojo count above ~9,007 XCH (App.tsx) — S effort
- [x] [BUG] `OffersScreen` create/take paths pass `Number(giveMojo)`, `Number(wantMojo)`, `Number(feeMojo)` to wallet daemon — precision lost above ~9,007 XCH equivalent (App.tsx) — S effort
- [x] [BUG] `WalletHome` `fetchAll` closes over stale `balance` state — `useCallback` missing `balance` dep; shows "Cannot reach proxy" on any transient failure even when a valid cached balance is displayed (App.tsx) — S effort
- [x] [FEAT] View/re-export seed phrase from Settings — no way to reveal stored mnemonic after setup; any user who needs to migrate or re-backup is stuck — S effort
- [x] [UX] Seed phrase verification quiz on wallet creation — currently a checkbox; MetaMask and Sage require re-entering 3 random words; highest-impact new-user security gap — S effort

## v0.11.0 — Bug Fixes & Web Deployment

- [x] [BUG] HistoryScreen `useEffect` has empty deps — wallet switches and nodeUrl changes don't trigger a history reload; promoted from vNext Code Quality Analysis 2026-06-27
- [x] [BUG] Password setup screen missing Back button — user stranded on 'password' mode with no way back; promoted from vNext Code Quality Analysis 2026-06-27
- [x] [UX/SEC] No Forgot Password / recovery path on LockScreen — users who forget their password appear permanently locked out; promoted from vNext Competitive Analysis 2026-06-27
- [x] [REFACTOR] Dead code removal — `sendXch` and `selectCoins` in spend.ts; inline XCH send path in SendScreen using `walletRpc`; promoted from vNext Code Quality Analysis 2026-06-27
- [x] [BUG] Proxy full-node route missing timeout — `app.post('/:endpoint')` has no timeout unlike the wallet daemon route; promoted from vNext Code Quality Analysis 2026-06-27
- [x] [UX/SEC] No Change Password in Settings — v0.10.0 added encryption but no way to rotate the password; promoted from vNext Competitive Analysis 2026-06-27
- [x] [UX/SEC] No idle auto-lock timeout — sessionKey stays in memory until tab close with no inactivity timeout; promoted from vNext Competitive Analysis 2026-06-27
- [x] [UX] Remove "Your Address" from WalletHome — redundant with Receive tab; home screen goes directly balance card → Assets
- [x] [FEAT] Proxy URL configurable in Settings — remove hardcoded `localhost:3001`; stored in localStorage; overrides `VITE_PROXY_URL` env var
- [x] [FEAT] Public Chia node dropdown in Settings — quick-select from a list of known public nodes alongside the manual URL field
- [x] [FEAT] Deploy script for Vercel/Netlify — `vercel.json` + `netlify.toml` with SPA routing rewrites
- [x] [FEAT] Environment config via `.env` — `VITE_PROXY_URL` default; `.env.example` checked in; proxy URL and node URL resolved from env → localStorage → default

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
- [x] [FEAT] Proxy XCH price guard `price < 100` will silently drop real prices if XCH ever exceeds $100 — raise the cap or remove it (proxy/index.js:175) — S effort
- [ ] [BUG] Transaction history is blank after manual CAT sends — `HistoryScreen` queries the wallet daemon (`get_transactions`) which has no record of sends made via `push_tx` directly to the full node; manual CAT spends need to be surfaced via coin-record lookups on the full node rather than the daemon history — M effort

## vNext — Code Quality Analysis (2026-06-27)
Build: clean (chunk-size warning only). Tests: 12/12 pass. Findings sorted by user impact.

- [ ] [SECURITY] All wallet mnemonics stored in plaintext in `localStorage['chia_wallets']` — any JS in the same origin (browser extension, injected script, XSS) can read every mnemonic with one call; highest-severity latent security gap in the codebase (App.tsx:2504) — L effort
- [ ] [BUG] Clawback send path passes `Number(amountMojo)` / `Number(feeMojo)` to `walletRpc` — the regular XCH send was fixed to use bigint-safe serialization but the clawback branch at App.tsx:2141–2144 still loses precision above ~9,007 XCH — S effort
- [ ] [BUG] `OffersScreen` create/take paths pass `Number(giveMojo)`, `Number(wantMojo)`, `Number(feeMojo)` to wallet daemon — same precision-loss pattern as the already-fixed NFT transfer bug; affects offers above ~9,007 XCH equivalent (App.tsx:1784, 1816–1817, 1829) — S effort
- [ ] [BUG] `formatMojoToXch` coerces BigInt through `Number()` before dividing — `Number(mojo) / 1_000_000_000_000` loses precision above 2^53 mojo (~9,007 XCH); affects every balance card and history row display (utils.ts:15) — S effort
- [ ] [BUG] `WalletHome` `fetchAll` closes over stale `balance` state — `useCallback` deps are `[nodeUrl, wallet.addresses]`, `balance` not included; on any transient network failure the stale-null comparison unconditionally shows "Cannot reach proxy" even when a valid cached balance is visible, alarming users (App.tsx:250, 253) — S effort
- [ ] [BUG] `HistoryScreen` receives empty `catBalances` if user navigates there before `WalletHome` finishes its initial CAT scan — `catBalances` initializes as `[]` and only populates via `onCatBalancesChange`; early navigation silently shows XCH-only history with no indicator that CAT history is incomplete (App.tsx:2434, 2607) — S effort
- [ ] [BUG] `walletRpc` does not check `response.ok` before calling `.json()` — a 5xx with an HTML error body throws `SyntaxError: Unexpected token '<'`, giving users no actionable message; all other fetch helpers in the codebase check `response.ok` (App.tsx:737–745) — S effort
- [ ] [BUG] Clawback countdown uses wall-clock time while on-chain clawback uses block timestamps — `expiresAt: Date.now() + clawbackTimelock * 1000` can disagree with node time by 1–3 minutes; "Recall" button may disappear before the on-chain window closes, causing users to lose their recall opportunity (App.tsx:2152) — S effort
- [ ] [BUG] `SendScreen` balance re-fetch `useEffect` lists `[status]` as its dep — fires a `get_wallet_balance` round-trip on every state-machine transition (idle→sending, sending→success/error), causing 2–3 extra daemon calls per send and a momentary stale balance flash (App.tsx:2083, 2095) — S effort
- [ ] [SECURITY] `puzzleCache` and `phAssetCache` in `localStorage` grow unbounded with no TTL or size cap — once localStorage fills (~5–10 MB) `savePuzzleCache()` silently fails; in-memory cache diverges from storage causing cache misses and repeated RPC calls on every reload (cats.ts:68–80, 171–175) — M effort
- [ ] [UX] `ReceiveScreen` "Show more" caps at 20 addresses instead of all 50 derived — `slice(0, 20)` means addresses 20–49 are never reachable; users who received funds at higher-index addresses cannot find them (App.tsx:382) — S effort
- [ ] [UX] `OffersScreen` Create tab binds both a `<select>` and a free-text `<input>` to the same `wantAssetId` state — after picking from the dropdown the text input is blank, tempting users to type and silently overwrite their selection (App.tsx:1915–1928) — S effort
- [ ] [UX] Navigating away from an in-progress Send or CatDetail form silently discards typed input — no "Leave? Your send will be cancelled." confirmation; standard safeguard in every competing wallet — S effort
- [ ] [UX] `NFTsScreen` has no retry button on error — if the daemon is unavailable the only recovery is navigating away and back to remount; a "Try again" button would fix this without a full remount (App.tsx:1279–1284) — S effort
- [ ] [PERF] `HistoryScreen` calls `calculateCoinId` for all historical coins simultaneously via `Promise.all` — unlike NFT metadata (which uses `mapConcurrent(…, 5)`), this fires one `crypto.subtle.digest` per coin with no concurrency limit; 200+ coins stalls the render for several seconds (App.tsx:1410–1412) — M effort
- [ ] [PERF] `deriveAddresses(mnemonic, 50)` runs synchronously in a microtask during wallet unlock — BLS12-381 scalar multiplication for 50 addresses is CPU-intensive; blocks the event loop with no spinner, freezing the UI for 1–3 s on mid-range devices (App.tsx:2469–2477, 2517–2524) — M effort
- [ ] [TEST] No tests cover `OffersScreen` — entire offer workflow (paste, decode, verify give/receive summary, accept; create, pick assets, copy string) is untested; a regression in offer parsing or `walletRpc` call shape would not be caught (tests/wallet.spec.ts) — M effort
- [ ] [TEST] `SendScreen` test asserts only that the form renders — does not verify: invalid address disables Send, zero amount blocks submission, Max button fills correct value, or error state renders on rejection (tests/wallet.spec.ts:96–106) — S effort
- [ ] [TEST] Wallet creation test does not assert mnemonic persistence — test confirms UI reaches "Total Balance" but never checks `localStorage['chia_wallets']`; a regression where data is created in memory but not persisted would still pass (tests/wallet.spec.ts:50–68) — S effort

## vNext — Competitive Analysis (2026-06-27)
Compared against: Sage Wallet, Official Chia GUI, Goby (browser extension), MetaMask-style best practices. Findings sorted by user impact.

- [ ] [UX] Seed phrase verification quiz on wallet creation — Wiznerd shows 24 words with a checkbox; MetaMask, Sage, and every major consumer wallet require re-entering 3–4 random words before unlocking; the single highest-impact security gap for new users — S effort
- [ ] [FEAT] View/re-export seed phrase from Settings — no way to reveal the stored mnemonic after setup; MetaMask calls this "Reveal secret recovery phrase"; any user who needs to migrate to a new device or re-backup has no path — S effort
- [ ] [FEAT] Coin consolidation / UTXO merge — Wiznerd dead-ends users with "Consolidate coins in the Chia GUI first" when no single CAT coin covers a send; Sage Wallet and the Official GUI both provide an in-wallet coin merge flow; hits every user who accumulates coins via DEX fills or airdrops — M effort
- [ ] [FEAT] Offer history and management — no record of created or taken offers; no way to cancel a pending (unlocked) offer after creation; Sage Wallet shows pending/completed/cancelled offers with a Cancel action; power users making multiple offers are flying blind — S effort
- [ ] [FEAT] Live Dexie offer book — users who want to take an offer must visit dexie.space, copy a string, return, and paste it; Sage Wallet and Goby show a browsable in-wallet offer list with one-tap accept; highest daily-use friction for traders — M effort
- [ ] [FEAT] One-tap Dexie offer posting — Create Offer outputs a string and shows a plain link; Sage submits directly to Dexie via API on creation; every offer creator experiences copy-paste friction on every trade — S effort
- [ ] [FEAT] Offer expiry / time-lock — offers created in Wiznerd lock the offered coins indefinitely until taken or wallet reset; Sage lets users set an expiry on creation; without this, stale offers can be accepted at unfavorable prices days later — S effort
- [ ] [FEAT] Total portfolio USD value — balance card shows XCH in USD only; no combined fiat total across XCH + all CAT holdings; Sage and MetaMask-style wallets show a single aggregate figure; users with significant CAT positions cannot see real net worth at a glance — S effort
- [ ] [UX] Address poisoning protection — no warning when a pasted address shares first/last N characters with an address book entry; MetaMask and Ledger Live both surface a prominent alert for this attack pattern; risk increases as address book grows — S effort
- [ ] [FEAT] Individual token hiding and custom ordering — the hide-small-balances toggle is all-or-nothing; MetaMask allows hiding individual tokens and reordering; users who receive spam CATs or prefer custom display order have no recourse — S effort
- [ ] [UX] Explorer link in send success banner — after a send confirms, the banner shows only text; Sage and the Official GUI display a "View on explorer" link inline; currently users must navigate History → expand row → tap link — several taps vs. zero in competing wallets — S effort
- [ ] [FEAT] NFT legs in offers (XCH/CAT ↔ NFT) — Offers screen supports XCH↔CAT only; the protocol natively supports NFT legs; Sage and the Official GUI both support buying/selling NFTs via offer strings; NFT collectors must leave Wiznerd entirely to trade — L effort
- [ ] [FEAT] DID management screen — Sage and the Official GUI allow creating and viewing Chia DIDs (identity primitive behind NFT royalties and verifiable credentials); users who hold DIDs see nothing in Wiznerd and must use another tool to link DID to a new wallet — M effort
- [ ] [FEAT] Hardware wallet support (Ledger) — Sage is the only Chia wallet with Ledger integration; users with significant holdings are advised to use hardware signing; without this Wiznerd is not viable as a primary wallet for high-value accounts — L effort
- [ ] [FEAT] Fiat on-ramp (MoonPay / Transak) — MetaMask, Trust Wallet, and Phantom all embed a fiat purchase widget; new Chia users who arrive without existing XCH must leave the wallet immediately to buy on a CEX; highest-friction step in the new-user funnel — M effort
- [ ] [FEAT] NFT minting — Sage and the Official GUI provide an in-wallet mint flow (upload data URI, set royalty, link to DID); creators must use a different wallet entirely; positions Wiznerd as a secondary tool for the creator segment — L effort
- [ ] [FEAT] CAT token issuance — Sage and the Official GUI allow issuing new CAT tokens (TAIL puzzle, mint amount, metadata); every project team that needs to create tokens must use another wallet; niche but high-value recurring segment — L effort
- [ ] [FEAT] dApp connectivity (CHIP-0002 wallet standard) — Goby is the only Chia wallet implementing the browser wallet API that allows dApps to request signatures without copy-pasting offer strings; without this Wiznerd cannot participate in the emerging Chia dApp ecosystem; requires a browser-extension architecture — L effort

## vNext — Code Quality Analysis (2026-06-27, v0.10.0 audit)
Build: clean. Tests: 15/15 pass. Findings sorted by user impact. Prior-session findings in the 2026-06-27 section above are not repeated here.

- [ ] [BUG] `HistoryScreen` `useEffect` has empty deps but closes over `wallet.addresses` — switching wallets while the History tab is mounted leaves the previous wallet's transaction list visible with no reload; navigating away and back is the only recovery (App.tsx:~1693) — M effort
- [ ] [BUG] `HistoryScreen` nodeUrl change not picked up — same empty-deps issue: if the user visits History before setting a node URL, then configures one in Settings, the "Set a node in Settings" message persists forever without an unmount/remount — S effort
- [ ] [BUG] `CatDetailScreen` reads address book from `localStorage` directly — `useMemo(() => JSON.parse(localStorage.getItem('chia_address_book') || '[]'), [])` bypasses the `ADDRESS_BOOK_KEY` constant and React state; entries added during the same session won't appear in the CAT-send address picker until a page reload (App.tsx:~1087) — S effort
- [ ] [BUG] `consolidateFee` NaN cascade on non-numeric input — `parseFloat(input)` → `Math.round(NaN)` → `BigInt(NaN)` throws "Cannot convert NaN to BigInt"; the raw JS error surfaces to the user instead of a validation message — S effort
- [ ] [BUG] `sendXch` in `spend.ts` is orphaned dead code — `SendScreen.handleSend` calls `walletRpc('send_transaction', ...)` directly and has done so since v0.8.0; `sendXch` and its exported `selectCoins` stub are never called but still bloat the bundle — S effort (spend.ts:23–52)
- [ ] [BUG] `WalletHome.fetchAll` silently swallows errors after first successful load — once `hasLoadedRef.current` is true, all subsequent poll failures are caught and ignored; the balance card shows stale data with no visual indicator that data may be outdated — S effort
- [ ] [BUG] `LockScreen` migration path uses `Promise.all` for wallet encryption — if any one wallet fails to encrypt, the entire batch throws and the user cannot proceed; `Promise.allSettled` with per-wallet error display would let the rest succeed — S effort (App.tsx:~LockScreen handleMigrate)
- [ ] [BUG] `onRemoveWallet` prop typed as `(id: string) => void` but `handleRemoveWallet` is `async` — the returned Promise is discarded; if the async path throws during salt/key cleanup after removing the last wallet, the error is silently lost and state may be partially reset — S effort
- [ ] [BUG] Proxy full-node route has no request timeout — `app.post('/:endpoint', ...)` has no timeout; a slow node response holds the proxy worker open indefinitely; the wallet daemon route correctly has `timeout: 20000` but the full-node route does not (chia-proxy/index.js:39–57) — S effort
- [ ] [UX] Password setup screen ('password' mode) has no Back button — a user who passes the quiz and reaches the password step cannot return to the mnemonic screen if they realize they didn't write down their words; the only escape is a page reload which loses all state — S effort
- [ ] [UX] No "Forgot password?" escape hatch on LockScreen — when the password is wrong the error gives no recovery path; users who forget their password appear permanently locked out; a "Restore from seed phrase" link at the bottom would surface the wipe-and-restore path that does exist but is invisible — S effort
- [ ] [UX] PBKDF2 derivation has no progress spinner — "Encrypting…" button label appears for 1–3 s on mid-range hardware with no spinner; users may click the disabled button repeatedly thinking the app froze — S effort
- [ ] [PERF] `toBase64` uses spread-into-`String.fromCharCode` — `btoa(String.fromCharCode(...bytes))` throws `RangeError: Maximum call stack size exceeded` for buffers > ~65 KB; safe for today's 32-byte salt and 264-byte ciphertext, but a copy-paste into a future larger-buffer use case would fail silently (crypto.ts:18) — S effort
- [ ] [TEST] LockScreen unlock flow has minimal coverage — only one test exercises the `unlockWallet()` helper (HistoryScreen scanning state); wrong-password rejection, Enter-key submission, and migrate-mode (legacy plaintext upgrade path) are completely untested — M effort
- [ ] [TEST] No test verifies mnemonics are encrypted at rest — `wallet home loads after completing creation flow` confirms "Total Balance" is visible but never inspects `localStorage['chia_wallets']`; a regression that stores a plaintext `mnemonic` field instead of `encryptedMnemonic` would pass all existing tests — S effort

## vNext — Competitive Analysis (2026-06-27, v0.10.0 audit)
Compared against: Sage Wallet, MetaMask, Rainbow, Phantom, Goby. Prior-session findings in the 2026-06-27 section above are not repeated here. Findings sorted by user impact.

- [ ] [UX/SEC] No "Change password" option in Settings — v0.10.0 sets a password at creation but offers no update path; MetaMask, Rainbow, and Phantom all surface "Change password" in security settings; users who want to rotate credentials must remove and re-import all wallets — S effort
- [ ] [UX/SEC] No idle auto-lock — `sessionKey` stays in memory until the browser tab is closed with no configurable inactivity timeout; MetaMask defaults to locking after 15 min; important on shared or public devices — S effort
- [ ] [UX] No "Forgot password?" recovery link on LockScreen — MetaMask and Phantom show "Forgot password? Restore from seed phrase" at the bottom of the unlock screen; Wiznerd shows only "Wrong password" with no hint that a seed-phrase restore path exists — S effort
- [ ] [FEAT] CNS (.xch domain) resolution in Send — Chia Name Service maps human-readable names like `alice.xch` to puzzle hashes; Sage Wallet and Goby both resolve CNS names in the send-to field before treating input as a raw address; Wiznerd accepts only bech32 addresses — M effort
- [ ] [FEAT] QR code scanner for recipient address — every mobile wallet (Trust Wallet, Rainbow, MetaMask Mobile, Phantom) supports opening the camera to scan a QR code as recipient; Wiznerd has no camera input; table-stakes for any mobile use — M effort
- [ ] [FEAT] CAT coin consolidation — v0.10.0 added XCH UTXO merging but CAT tokens still surface "No single coin covers this amount"; Sage Wallet's "Combine coins" handles XCH and all CAT asset types; every user who accumulates CAT via DEX fills hits this wall — M effort
- [ ] [FEAT] Testnet support — Sage, Goby, and the Official GUI all have a mainnet/testnet toggle; Wiznerd's node URL is manually editable but there's no quick-switch button, no testnet address-prefix validation, and no visual network indicator — M effort
- [ ] [UX] SendScreen balance sourced from wallet daemon, WalletHome from full node — the two figures can diverge if the daemon is behind the chain tip; users who see a balance on Home may see a different (stale) figure in Send — M effort
- [ ] [UX] History "View block" link targets the block, not the specific coin — Spacescan.io has `/coin/:coinId` deep links; the current link goes to `/block/${blockIndex}` which contains dozens of unrelated transactions; Sage and the Official GUI link directly to the coin — S effort
- [ ] [UX] No Dexie verified-token badge — the Dexie token list distinguishes verified tokens from unverified; Wiznerd shows all CATs identically; users cannot distinguish well-known tokens from spam/scam CATs — S effort
- [ ] [FEAT] Fiat-denominated send input — type an amount in USD and have it auto-convert to XCH/CAT; MetaMask and Coinbase Wallet both support this; reduces cognitive load for users who think in fiat — S effort