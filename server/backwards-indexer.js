'use strict';
// Backwards NFT indexer — crawls blocks from current peak down to MIN_BLOCK.
// Skips blocks already recorded in indexed_blocks (safe to run alongside
// the forward indexer). Run on the home machine where the Chia node lives.
//
// Usage:
//   node server/backwards-indexer.js
//   node server/backwards-indexer.js --from 4000000   # override start height
//   node server/backwards-indexer.js --min 2500000    # override minimum height

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const PROXY      = process.env.PROXY_URL || 'http://localhost:3001';
const MIN_BLOCK  = 3_000_000;   // ~Jan 2024 — don't crawl past this
const BATCH_SIZE = 20;          // blocks per iteration
const COIN_DELAY = 80;          // ms between nft_get_info calls within a block
const BATCH_DELAY = 1500;       // ms between batches (be kind to the node)

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const fromIdx = args.indexOf('--from');
const minIdx  = args.indexOf('--min');
const startOverride = fromIdx !== -1 ? parseInt(args[fromIdx + 1], 10) : null;
const minOverride   = minIdx  !== -1 ? parseInt(args[minIdx  + 1], 10) : null;
const MIN_HEIGHT = minOverride ?? MIN_BLOCK;

// ── Supabase ──────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { realtime: { transport: ws } }
);

// ── RPC helpers ───────────────────────────────────────────────────────────────
async function nodeRpc(endpoint, body = {}) {
  const res = await fetch(`${PROXY}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`node RPC ${endpoint}: HTTP ${res.status}`);
  return res.json();
}

async function walletRpc(endpoint, body = {}) {
  const res = await fetch(`${PROXY}/wallet/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`wallet RPC ${endpoint}: HTTP ${res.status}`);
  return res.json();
}

function coinId(coin) {
  const parent = Buffer.from(coin.parent_coin_info.replace('0x', ''), 'hex');
  const puzzle = Buffer.from(coin.puzzle_hash.replace('0x', ''), 'hex');
  const amount = Buffer.allocUnsafe(8);
  amount.writeBigUInt64BE(BigInt(coin.amount));
  return crypto.createHash('sha256')
    .update(Buffer.concat([parent, puzzle, amount]))
    .digest('hex');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── IPFS metadata fetch ───────────────────────────────────────────────────────
async function fetchMetadata(uri) {
  if (!uri) return null;
  let url = uri.startsWith('ipfs://')
    ? `https://gateway.pinata.cloud/ipfs/${uri.replace('ipfs://', '')}`
    : uri;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) return null;
    return await res.json();
  } catch { return null; }
}

// ── Sale price extraction ─────────────────────────────────────────────────────
function extractSalePrice(blockAdditions, sellerPuzzleHash) {
  if (!blockAdditions?.length || !sellerPuzzleHash) return null;
  const sellerHex = sellerPuzzleHash.replace('0x', '').toLowerCase();
  const xchToSeller = blockAdditions.filter(a => {
    const ph = (a.coin.puzzle_hash || '').replace('0x', '').toLowerCase();
    return ph === sellerHex && BigInt(a.coin.amount || 0) > 1n;
  });
  if (!xchToSeller.length) return null;
  return xchToSeller.reduce((sum, a) => sum + Number(a.coin.amount), 0);
}

// ── Process one NFT coin ──────────────────────────────────────────────────────
async function processCoin(id, blockHeight, blockAdditions = []) {
  let info;
  try {
    const res = await walletRpc('nft_get_info', { coin_id: `0x${id}` });
    if (!res.success || !res.nft_info) return false;
    info = res.nft_info;
  } catch { return false; }

  const nftId = info.launcher_id || info.nft_id;
  if (!nftId) return false;

  const metadataUri     = (info.metadata_uris || [])[0] || null;
  const imageUri        = (info.data_uris || [])[0] || null;
  const dataHash        = info.data_hash     || null;
  const metaHash        = info.metadata_hash || null;
  const minterDid       = info.minter_did    || null;
  const ownerPuzzleHash = info.p2_address    || null;

  const imageUrl = imageUri
    ? (imageUri.startsWith('ipfs://')
        ? `https://gateway.pinata.cloud/ipfs/${imageUri.replace('ipfs://', '')}`
        : imageUri)
    : null;

  const meta          = await fetchMetadata(metadataUri);
  const collectionId  = meta?.collection?.id     || null;
  const seriesNumber  = meta?.series_number      ?? null;
  const seriesTotal   = meta?.series_total       ?? 0;
  const nftName       = meta?.name               || null;
  const traits        = meta?.attributes
    ? Object.fromEntries(meta.attributes.map(a => [a.trait_type, String(a.value)]))
    : {};

  if (collectionId) {
    const collectionAttrs = meta?.collection?.attributes || [];
    const iconAttr = collectionAttrs.find(a => a.type === 'icon');
    let thumbnailUrl = iconAttr?.value
      ? (iconAttr.value.startsWith('ipfs://')
          ? `https://gateway.pinata.cloud/ipfs/${iconAttr.value.replace('ipfs://', '')}`
          : iconAttr.value)
      : imageUrl;

    const { data: existingCol } = await supabase
      .from('indexed_collections')
      .select('minted_count, total_supply, thumbnail_url, verified, floor_price_mojo')
      .eq('collection_id', collectionId)
      .maybeSingle();

    await supabase.from('indexed_collections').upsert({
      collection_id:    collectionId,
      name:             meta?.collection?.name || 'Unknown Collection',
      description:      collectionAttrs.find(a => a.type === 'description')?.value || null,
      thumbnail_url:    thumbnailUrl || existingCol?.thumbnail_url || null,
      total_supply:     seriesTotal  || existingCol?.total_supply  || 0,
      minted_count:     (existingCol?.minted_count || 0) + 1,
      floor_price_mojo: existingCol?.floor_price_mojo || 0,
      creator_did:      minterDid || null,
      source:           existingCol?.source || 'onchain',
      verified:         existingCol?.verified || false,
      external_url:     `https://mintgarden.io/collections/${collectionId}`,
      last_seen_block:  blockHeight,
      updated_at:       new Date().toISOString(),
    }, { onConflict: 'collection_id' });
  }

  const { data: existing } = await supabase
    .from('indexed_nfts')
    .select('owner_puzzle_hash')
    .eq('nft_id', nftId)
    .maybeSingle();

  const prevOwner  = existing?.owner_puzzle_hash || null;
  const isTransfer = prevOwner && ownerPuzzleHash && prevOwner !== ownerPuzzleHash;
  const isMint     = !prevOwner && ownerPuzzleHash;

  await supabase.from('indexed_nfts').upsert({
    nft_id:            nftId,
    collection_id:     collectionId,
    token_index:       seriesNumber != null ? seriesNumber - 1 : null,
    name:              nftName,
    metadata_uri:      metadataUri,
    image_url:         imageUrl,
    data_hash:         dataHash,
    meta_hash:         metaHash,
    owner_puzzle_hash: ownerPuzzleHash,
    minter_did:        minterDid,
    confirmed_block:   blockHeight,
    traits,
    updated_at:        new Date().toISOString(),
  }, { onConflict: 'nft_id' });

  if (isMint) {
    await supabase.from('nft_transfers').insert({
      nft_id: nftId, collection_id: collectionId,
      from_puzzle_hash: null, to_puzzle_hash: ownerPuzzleHash,
      price_mojo: null, block_height: blockHeight,
      transferred_at: new Date().toISOString(),
      source: 'onchain', event_type: 'mint',
    }).select();
  } else if (isTransfer) {
    const priceMojo = extractSalePrice(blockAdditions, prevOwner);
    await supabase.from('nft_transfers').insert({
      nft_id: nftId, collection_id: collectionId,
      from_puzzle_hash: prevOwner, to_puzzle_hash: ownerPuzzleHash,
      price_mojo: priceMojo, block_height: blockHeight,
      transferred_at: new Date().toISOString(),
      source: 'onchain', event_type: priceMojo ? 'sale' : 'transfer',
    }).select();
  }

  return true;
}

// ── Process one block (backwards direction) ───────────────────────────────────
async function processBlock(height) {
  // Skip if already processed by either indexer
  const { data: seen } = await supabase
    .from('indexed_blocks')
    .select('block_height')
    .eq('block_height', height)
    .maybeSingle();
  if (seen) return true; // already done

  let additions;
  try {
    const blockRecord = await nodeRpc('get_block_record_by_height', { height });
    if (!blockRecord.block_record) return false;
    const ar = await nodeRpc('get_additions_and_removals', {
      header_hash: blockRecord.block_record.header_hash,
    });
    additions = ar.additions || [];
  } catch (e) {
    console.error(`[back-indexer] block ${height} RPC error: ${e.message}`);
    return false;
  }

  const candidates = additions.filter(r => BigInt(r.coin.amount) === 1n);
  let nftEvents = 0;

  if (candidates.length) {
    for (const candidate of candidates) {
      const id = coinId(candidate.coin);
      const found = await processCoin(id, height, additions);
      if (found) nftEvents++;
      await sleep(COIN_DELAY);
    }
  }

  await supabase.from('indexed_blocks').upsert(
    { block_height: height, nft_events: nftEvents, cat_events: 0 },
    { onConflict: 'block_height' }
  );

  return false; // not skipped
}

// ── State persistence ─────────────────────────────────────────────────────────
// We store progress in a simple JSON file so we can resume after interruption.
const STATE_FILE = require('path').join(__dirname, '..', '.backwards-indexer-state.json');
const fss = require('fs');

function loadState() {
  try { return JSON.parse(fss.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveState(height) {
  fss.writeFileSync(STATE_FILE, JSON.stringify({ height, updatedAt: new Date().toISOString() }));
}

// ── Main crawl loop ───────────────────────────────────────────────────────────
async function main() {
  console.log('[back-indexer] starting backwards NFT indexer');
  console.log(`[back-indexer] will crawl down to block ${MIN_HEIGHT.toLocaleString()}`);

  // Determine start height
  let currentHeight;
  if (startOverride) {
    currentHeight = startOverride;
    console.log(`[back-indexer] start override: block ${currentHeight.toLocaleString()}`);
  } else {
    const saved = loadState();
    if (saved.height) {
      currentHeight = saved.height;
      console.log(`[back-indexer] resuming from block ${currentHeight.toLocaleString()}`);
    } else {
      const chainState = await nodeRpc('get_blockchain_state');
      currentHeight = chainState.blockchain_state?.peak?.height;
      if (!currentHeight) { console.error('[back-indexer] cannot get peak height'); process.exit(1); }
      console.log(`[back-indexer] starting from peak: block ${currentHeight.toLocaleString()}`);
    }
  }

  let processed = 0;
  let skipped   = 0;
  let nftTotal  = 0;

  while (currentHeight > MIN_HEIGHT) {
    const batchEnd   = currentHeight;
    const batchStart = Math.max(currentHeight - BATCH_SIZE + 1, MIN_HEIGHT + 1);

    for (let h = batchEnd; h >= batchStart; h--) {
      const wasSkipped = await processBlock(h);
      if (wasSkipped) skipped++;
      else processed++;

      if (processed % 100 === 0 && processed > 0) {
        console.log(`[back-indexer] ↓ block ${h.toLocaleString()} | processed: ${processed} | skipped: ${skipped} | remaining: ~${(h - MIN_HEIGHT).toLocaleString()}`);
        saveState(h);
      }
    }

    currentHeight = batchStart - 1;
    saveState(currentHeight);
    await sleep(BATCH_DELAY);
  }

  console.log(`[back-indexer] ✓ complete. Processed ${processed} blocks, skipped ${skipped} already-indexed.`);
}

main().catch(e => { console.error('[back-indexer] fatal:', e); process.exit(1); });
