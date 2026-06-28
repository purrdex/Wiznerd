# Wiznerd Wallet — Claude Code Context

## Project Overview
A Chia blockchain wallet built in React/TypeScript. Proof-of-concept for the Chia team.
No Chia SDK dependencies in the frontend — all crypto handled via local node RPC.

## File Locations
- Frontend: C:\Users\B_Str\chia-wallet\ (this folder, localhost:3000)
- Proxy: C:\Users\B_Str\chia-proxy\index.js (localhost:3001)
- Chia full node: localhost:8555 (SSL)
- Chia wallet daemon: localhost:9256 (SSL)

## Key Source Files
- src/main.tsx — React Router entry point (/ wallet, /create, /marketplace)
- src/wallet/App.tsx — all wallet UI screens and components
- src/wallet/App.css — dark theme, mobile-first, 420px max-width
- src/wallet/lib/keys.ts — BLS key derivation
- src/wallet/lib/cats.ts — CAT token discovery, metadata, prices
- src/wallet/lib/spend.ts — XCH sends via wallet daemon RPC
- src/wallet/lib/node.ts — Chia full node RPC calls
- src/create/index.tsx — generative art studio (placeholder)
- src/marketplace/index.tsx — NFT marketplace (placeholder)

## Running the App
- Frontend: npm start (in chia-wallet/)
- Proxy: node index.js (in chia-proxy/)
- Tests: npx playwright test (in chia-wallet/)
- Build check: npm run build

## Architecture Rules
- All external API calls go through the proxy (CORS)
- XCH sends use wallet daemon send_transaction (port 9256)
- NFT transfers use wallet daemon nft_transfer_nft (port 9256)
- CAT token metadata comes from Dexie /v1/tokens (926 tokens, cached)
- Token logos from icons.dexie.space via proxy /logo/:assetId
- XCH price from Gate.io via proxy /price/xch

## Proxy Routes (C:\Users\B_Str\chia-proxy\index.js)
- POST /:endpoint → Chia full node RPC (port 8555)
- POST /wallet/:endpoint → Chia wallet daemon (port 9256)
- GET /taildatabase/:assetId → taildatabase then Dexie fallback
- GET /logo/:assetId → icons.dexie.space
- GET /price/xch → Gate.io XCH/USDT
- GET /price/cat/:assetId → Dexie completed offers

## Working Features
- Mnemonic import/create (BIP39 24 words)
- XCH balance + USD value
- CAT token discovery, names, logos, prices
- Send XCH via wallet daemon
- NFT display (PNG + MP4 video)
- NFT transfer with royalty display
- Receive addresses
- Settings with node config

## Coding Standards
- TypeScript strict mode
- Functional components with hooks
- CSS classes over inline styles where possible
- No console.log in production code
- All fetch calls need AbortSignal.timeout()
- Always run npm run build before committing
- Run playwright tests after any UI change

## Commit Format
feat: description (vX.X.X)
fix: description (vX.X.X)
test: description (vX.X.X)


## Current State (last updated)
- v0.13.0 complete — Platform restructure: React Router added, wallet moved to src/wallet/, placeholder /create and /marketplace routes added
- All 17 tests passing, build clean at 660 KB / 190 KB gzip (react-router-dom adds ~95 KB; chunk warning is pre-existing)
- Route / serves wallet app (unchanged behavior); /create and /marketplace are placeholder screens
- src/wallet/App.tsx and src/wallet/lib/* are the wallet source; src/create/ and src/marketplace/ are new sections

## Platform Security Strategy
- Web: password-derived encryption (PBKDF2 + AES-256-GCM), salt in localStorage
- iOS: iOS Keychain via react-native-keychain, Face ID/Touch ID, no password prompt
- Android: Android Keystore via react-native-keychain, biometrics, no password prompt
- Core wallet logic in src/lib/ is platform-agnostic TypeScript, ports directly to RN