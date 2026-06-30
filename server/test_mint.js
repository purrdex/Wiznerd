'use strict';
require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROXY = process.env.PROXY_URL || 'http://localhost:3001';
const TARGET = process.argv[2] || '';

if (!TARGET) {
  console.error('Usage: node server/test_mint.js <recipient-xch-address>');
  process.exit(1);
}

// Token 87 — real collection data with meta_hash
const IMAGE_CID_PATH = 'bafybeid7hhgm2iihvmwlmhlx56vjjkrq4zb3tkf3qorsi47teddjfgybym/87.png';
const META_CID_PATH  = 'bafybeib6sqwwvglbayjom2uadcpptykt7ess3s5rptdcafjejqyedrqacy/87.json';
const DATA_HASH      = '09156af8377191089702d42328acc8b133d809df2b7465f333244e6e1982511e';
const META_HASH      = 'dcaa5feaa9c960e5c13b6426966ffe461e2e9ae6b3cd5baa5fb5a3b8935b5f53';

async function getNFTWalletId() {
  if (process.env.MINTER_NFT_WALLET_ID) return parseInt(process.env.MINTER_NFT_WALLET_ID);
  const res = await fetch(`${PROXY}/wallet/get_wallets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 10 }),
    signal: AbortSignal.timeout(10000),
  });
  const j = await res.json();
  const w = (j.wallets || []).find(w => w.type === 10 && w.data?.includes('"did_id"'));
  if (!w) throw new Error('No DID-linked NFT wallet found');
  return w.id;
}

async function getNodeAddress() {
  if (process.env.MINTER_ADDRESS) return process.env.MINTER_ADDRESS;
  const res = await fetch(`${PROXY}/wallet/get_next_address`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet_id: 1, new_address: false }),
    signal: AbortSignal.timeout(10000),
  });
  const j = await res.json();
  return j.address;
}

async function waitForNFTInWallet(walletId, maxWaitMs = 300000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await fetch(`${PROXY}/wallet/nft_get_nfts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet_id: walletId }),
      signal: AbortSignal.timeout(10000),
    });
    const j = await res.json();
    if (j.nft_list && j.nft_list.length > 0) {
      console.log(`\nNFT confirmed in wallet ${walletId}:`, j.nft_list.map(n => n.nft_id));
      return j.nft_list[0];
    }
    const elapsed = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`\r  waiting for NFT in wallet ${walletId}... ${elapsed}s`);
    await new Promise(r => setTimeout(r, 15000));
  }
  throw new Error(`Timed out waiting for NFT in wallet ${walletId}`);
}

async function waitForSpendable(maxWaitMs = 300000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await fetch(`${PROXY}/wallet/get_wallet_balance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet_id: 1 }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const j = await res.json();
      const spendable = BigInt(j.wallet_balance?.spendable_balance ?? 0);
      if (spendable > 0n) return;
    }
    process.stdout.write(`\r  waiting for spendable balance... ${Math.round((Date.now() - start) / 1000)}s`);
    await new Promise(r => setTimeout(r, 15000));
  }
  throw new Error('Timed out waiting for spendable balance');
}

async function run() {
  const walletId = await getNFTWalletId();
  const nodeAddress = await getNodeAddress();
  console.log('NFT wallet id:', walletId, '| Node address:', nodeAddress);

  // Step 1: Mint to our OWN node address so NFT lands in wallet_id=4 (DID-linked)
  const body = {
    wallet_id: walletId,
    uris: [
      `https://gateway.pinata.cloud/ipfs/${IMAGE_CID_PATH}`,
      `ipfs://${IMAGE_CID_PATH}`,
    ],
    hash: DATA_HASH,
    meta_uris: [
      `https://gateway.pinata.cloud/ipfs/${META_CID_PATH}`,
      `ipfs://${META_CID_PATH}`,
    ],
    meta_hash: META_HASH,
    series_number: 88,
    series_total: 100,
    did_id: process.env.MINTER_DID || undefined,
    target_address: nodeAddress,
    royalty_address: TARGET,
    royalty_percentage: 0,
    fee: 0,
  };

  console.log('\nStep 1 — minting NFT to node address...');
  const mintRes = await fetch(`${PROXY}/wallet/nft_mint_nft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });

  const mintText = await mintRes.text();
  let mintJson;
  try { mintJson = JSON.parse(mintText); } catch { console.error('Bad JSON:', mintText); process.exit(1); }
  if (!mintJson.success) { console.error('Mint failed:', mintJson.error || mintText); process.exit(1); }
  console.log('Mint submitted, NFT ID:', mintJson.nft_id);

  // Step 2: Wait for NFT to confirm in wallet_id=4
  console.log('\nStep 2 — waiting for NFT to confirm in DID wallet...');
  const nft = await waitForNFTInWallet(walletId);
  const nftCoinId = nft.nft_coin_id;
  console.log('NFT coin id:', nftCoinId);

  // Step 3: Wait for spendable balance, then transfer to buyer
  console.log('\nStep 3 — waiting for spendable balance...');
  await waitForSpendable();

  const transferBody = {
    wallet_id: walletId,
    nft_coin_id: nftCoinId,
    target_address: TARGET,
    fee: 0,
  };
  console.log('\nTransferring to buyer:', TARGET);
  const txRes = await fetch(`${PROXY}/wallet/nft_transfer_nft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(transferBody),
    signal: AbortSignal.timeout(120000),
  });
  const txText = await txRes.text();
  let txJson;
  try { txJson = JSON.parse(txText); } catch { throw new Error(`transfer bad JSON: ${txText.slice(0,200)}`); }
  if (!txJson.success) { console.error('Transfer failed:', txJson.error || txText); process.exit(1); }

  console.log('\nDone!');
  console.log('NFT ID:', mintJson.nft_id);
  console.log('Transfer TX:', txJson.transaction_id || txJson.tx_id);
}

run().catch(e => { console.error(e.message); process.exit(1); });
