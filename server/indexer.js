'use strict';
// Forward-looking NFT indexer: polls the Chia full node for new blocks,
// decodes NFT coins, and writes to indexed_collections + indexed_nfts.
// Started by server/index.js; can also run standalone: node server/indexer.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const PROXY        = process.env.PROXY_URL || 'http://localhost:3001';
const POLL_MS      = 30_000;   // check for new blocks every 30s
const BLOCK_BATCH  = 5;        // process this many blocks per poll
const COIN_DELAY   = 150;      // ms between nft_get_info calls per block

let supabase;
function getSupabase() {
  if (supabase) return supabase;
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { realtime: { transport: ws } });
  return supabase;
}

// ── RPC helpers ───────────────────────────────────────────────────────────────

async function nodeRpc(endpoint, body = {}) {
  const res = await fetch(`${PROXY}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`node RPC ${endpoint}: HTTP ${res.status}`);
  return res.json();
}

async function walletRpc(endpoint, body = {}) {
  const res = await fetch(`${PROXY}/wallet/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`wallet RPC ${endpoint}: HTTP ${res.status}`);
  return res.json();
}

// Compute Chia coin ID: SHA256(parent_coin_info || puzzle_hash || uint64(amount))
function coinId(coin) {
  const parent = Buffer.from(coin.parent_coin_info.replace('0x', ''), 'hex');
  const puzzle = Buffer.from(coin.puzzle_hash.replace('0x', ''), 'hex');
  const amount = Buffer.allocUnsafe(8);
  amount.writeBigUInt64BE(BigInt(coin.amount));
  return crypto.createHash('sha256')
    .update(Buffer.concat([parent, puzzle, amount]))
    .digest('hex');
}

// ── IPFS metadata fetch ───────────────────────────────────────────────────────

async function fetchMetadata(uri) {
  if (!uri) return null;
  let url = uri;
  if (url.startsWith('ipfs://')) {
    url = `https://gateway.pinata.cloud/ipfs/${url.replace('ipfs://', '')}`;
  }
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ── Process a single candidate coin ──────────────────────────────────────────

async function processCoin(id, blockHeight) {
  const db = getSupabase();

  // Ask wallet daemon to decode as NFT — fails fast if it's not an NFT
  let info;
  try {
    const res = await walletRpc('nft_get_info', { coin_id: `0x${id}` });
    if (!res.success || !res.nft_info) return;
    info = res.nft_info;
  } catch {
    return; // not an NFT or wallet can't see it
  }

  const nftId = info.launcher_id || info.nft_id;
  if (!nftId) return;

  const metadataUri   = (info.metadata_uris || [])[0] || null;
  const imageUri      = (info.data_uris || [])[0] || null;
  const dataHash      = info.data_hash      || null;
  const metaHash      = info.metadata_hash  || null;
  const minterDid     = info.minter_did     || null;
  const ownerPuzzleHash = info.p2_address   || null;

  // Resolve image URL for storage
  const imageUrl = imageUri
    ? (imageUri.startsWith('ipfs://')
        ? `https://gateway.pinata.cloud/ipfs/${imageUri.replace('ipfs://', '')}`
        : imageUri)
    : null;

  // Fetch off-chain CHIP-0007 metadata
  const meta = await fetchMetadata(metadataUri);

  const collectionId = meta?.collection?.id || null;
  const seriesNumber = meta?.series_number  ?? null;
  const seriesTotal  = meta?.series_total   ?? 0;
  const nftName      = meta?.name           || null;
  const traits       = meta?.attributes
    ? Object.fromEntries(meta.attributes.map(a => [a.trait_type, String(a.value)]))
    : {};

  // Upsert collection record if we have a collection.id
  if (collectionId) {
    const collectionAttrs = meta?.collection?.attributes || [];
    const iconAttr = collectionAttrs.find(a => a.type === 'icon');
    let thumbnailUrl = iconAttr?.value
      ? (iconAttr.value.startsWith('ipfs://')
          ? `https://gateway.pinata.cloud/ipfs/${iconAttr.value.replace('ipfs://', '')}`
          : iconAttr.value)
      : imageUrl;

    // Upsert — if exists keep verified/floor_price from backfill, update counts/thumbnail
    const { data: existing } = await db
      .from('indexed_collections')
      .select('minted_count, total_supply, thumbnail_url, verified, floor_price_mojo')
      .eq('collection_id', collectionId)
      .maybeSingle();

    await db.from('indexed_collections').upsert({
      collection_id:    collectionId,
      name:             meta?.collection?.name || 'Unknown Collection',
      description:      meta?.collection?.attributes?.find(a => a.type === 'description')?.value || null,
      thumbnail_url:    thumbnailUrl || existing?.thumbnail_url || null,
      total_supply:     seriesTotal  || existing?.total_supply  || 0,
      minted_count:     (existing?.minted_count || 0) + (existing ? 1 : 1),
      floor_price_mojo: existing?.floor_price_mojo || 0,
      creator_did:      minterDid || null,
      source:           existing ? existing.source || 'onchain' : 'onchain',
      verified:         existing?.verified || false,
      external_url:     `https://mintgarden.io/collections/${collectionId}`,
      last_seen_block:  blockHeight,
      updated_at:       new Date().toISOString(),
    }, { onConflict: 'collection_id' });
  }

  // Upsert NFT record
  await db.from('indexed_nfts').upsert({
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

  console.log(`[indexer] NFT ${nftId.slice(0, 20)}… | collection: ${collectionId?.slice(0, 16) || 'none'} | block ${blockHeight}`);
}

// ── Process one block ─────────────────────────────────────────────────────────

async function processBlock(height) {
  const record = await nodeRpc('get_block_record_by_height', { height });
  if (!record.block_record) return;

  const { additions } = await nodeRpc('get_additions_and_removals', {
    header_hash: record.block_record.header_hash,
  });
  if (!additions?.length) return;

  // Singletons (NFTs, DIDs) always have amount = 1 mojo
  const candidates = additions.filter(r => BigInt(r.coin.amount) === 1n);
  if (!candidates.length) return;

  console.log(`[indexer] block ${height}: ${additions.length} additions, ${candidates.length} singleton candidates`);

  for (const record of candidates) {
    const id = coinId(record.coin);
    await processCoin(id, height);
    await new Promise(r => setTimeout(r, COIN_DELAY));
  }
}

// ── Indexer state ─────────────────────────────────────────────────────────────

async function getState() {
  const db = getSupabase();
  const { data, error } = await db.from('indexer_state').select('*').eq('id', 1).maybeSingle();
  if (error) console.error('[indexer] getState error:', error.message);
  return data;
}

async function setState(height, hash) {
  const db = getSupabase();
  const { error } = await db.from('indexer_state').upsert(
    { id: 1, last_block_height: height, last_block_hash: hash, updated_at: new Date().toISOString() },
    { onConflict: 'id' }
  );
  if (error) console.error('[indexer] setState error:', error.message);
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function poll() {
  try {
    const chainState = await nodeRpc('get_blockchain_state');
    const peakHeight = chainState.blockchain_state?.peak?.height;
    if (!peakHeight) return;

    let state = await getState();
    if (!state) {
      // First run — start from current peak, don't backfill history (MintGarden covers that)
      await setState(peakHeight, null);
      console.log(`[indexer] initialized at block ${peakHeight}`);
      return;
    }

    const from = state.last_block_height;
    if (from >= peakHeight) return; // already up to date

    const to = Math.min(from + BLOCK_BATCH, peakHeight);
    for (let h = from + 1; h <= to; h++) {
      await processBlock(h);
    }

    // Save progress
    const last = await nodeRpc('get_block_record_by_height', { height: to });
    await setState(to, last.block_record?.header_hash || null);
    if (to < peakHeight) {
      console.log(`[indexer] processed ${from + 1}–${to} (${peakHeight - to} blocks behind)`);
    }
  } catch (e) {
    console.error('[indexer] poll error:', e.message);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

function start() {
  console.log('[indexer] starting block watcher');
  poll();
  return setInterval(poll, POLL_MS);
}

module.exports = { start };

// Run standalone
if (require.main === module) {
  start();
}
