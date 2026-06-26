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
- src/App.tsx — all UI screens and components
- src/App.css — dark theme, mobile-first, 420px max-width
- src/lib/keys.ts — BLS key derivation
- src/lib/cats.ts — CAT token discovery, metadata, prices
- src/lib/spend.ts — XCH sends via wallet daemon RPC
- src/lib/node.ts — Chia full node RPC calls

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