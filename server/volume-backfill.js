'use strict';
// On-chain volume backfill — walks the singleton coin chain for every NFT in a
// collection and records each transfer + sale price in nft_transfers.
// No MintGarden dependency.
//
// Usage:
//   node server/volume-backfill.js <collection_id>          # single collection
//   node server/volume-backfill.js <collection_id> --fresh  # wipe existing transfers first

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabase   = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { realtime: { transport: ws } });
const PROXY      = process.env.PROXY_URL || 'http://localhost:3001';
const CONCURRENCY = 2;   // NFTs walked in parallel
const STEP_DELAY  = 150; // ms between node RPC calls per worker
const BLOCK_CACHE = new Map(); // height → additions array (avoid re-fetching same block)

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function coinId(coin) {
  const parent = Buffer.from(coin.parent_coin_info.replace('0x', ''), 'hex');
  const puzzle = Buffer.from(coin.puzzle_hash.replace('0x', ''), 'hex');
  const amount = Buffer.allocUnsafe(8);
  amount.writeBigUInt64BE(BigInt(coin.amount));
  return crypto.createHash('sha256')
    .update(Buffer.concat([parent, puzzle, amount]))
    .digest('hex');
}

// Decode nft1... bech32m → hex launcher_id
function decodeNftId(nftId) {
  const { bech32m } = require('bech32');
  try {
    const d = bech32m.decode(nftId, 90);
    return Buffer.from(bech32m.fromWords(d.words)).toString('hex');
  } catch { return null; }
}

// ── Block additions cache ─────────────────────────────────────────────────────

async function getBlockAdditions(height) {
  if (BLOCK_CACHE.has(height)) return BLOCK_CACHE.get(height);
  try {
    const record = await nodeRpc('get_block_record_by_height', { height });
    if (!record.block_record) return [];
    const { additions } = await nodeRpc('get_additions_and_removals', {
      header_hash: record.block_record.header_hash,
    });
    const result = additions || [];
    BLOCK_CACHE.set(height, result);
    // Keep cache small — evict oldest if over 200 entries
    if (BLOCK_CACHE.size > 200) {
      BLOCK_CACHE.delete(BLOCK_CACHE.keys().next().value);
    }
    return result;
  } catch { return []; }
}

// ── Price extraction (same logic as indexer) ──────────────────────────────────

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

// ── Walk one NFT's singleton chain ────────────────────────────────────────────

async function walkNft(nftId, collectionId) {
  const launcherHex = decodeNftId(nftId);
  if (!launcherHex) return [];

  const transfers = [];
  let parentHex = launcherHex;

  while (true) {
    await sleep(STEP_DELAY);

    // Get the coin created from this parent (next link in singleton chain)
    let coinRecords;
    try {
      const res = await nodeRpc('get_coin_records_by_parent_ids', {
        parent_ids: [`0x${parentHex}`],
        include_spent_coins: true,
      });
      coinRecords = res.coin_records || [];
    } catch { break; }

    // Singleton chain has exactly one child per parent
    const singleton = coinRecords.find(r => BigInt(r.coin.amount) === 1n);
    if (!singleton) break;

    const thisCoinId = coinId(singleton.coin);

    if (singleton.spent) {
      const spentHeight = singleton.spent_block_index;

      // Get owner at this coin state so we know who the seller is
      let sellerPh = null;
      try {
        const info = await walletRpc('nft_get_info', { coin_id: `0x${thisCoinId}` });
        sellerPh = info.nft_info?.p2_address || null;
      } catch { /* price will be null */ }

      // Get block additions and attempt price extraction
      const additions = await getBlockAdditions(spentHeight);
      const priceMojo = extractSalePrice(additions, sellerPh);

      transfers.push({
        nft_id:           nftId,
        collection_id:    collectionId,
        from_puzzle_hash: sellerPh,
        to_puzzle_hash:   null, // resolved when next coin is processed
        price_mojo:       priceMojo,
        block_height:     spentHeight,
        transferred_at:   new Date(singleton.timestamp * 1000).toISOString(),
        source:           'onchain',
      });

      // Resolve buyer: the next coin's owner
      parentHex = thisCoinId;
    } else {
      // Reached the current unspent coin — we're done
      break;
    }
  }

  // Fill in to_puzzle_hash by looking at the next transfer's from
  for (let i = 0; i < transfers.length - 1; i++) {
    transfers[i].to_puzzle_hash = transfers[i + 1].from_puzzle_hash;
  }

  return transfers;
}

// ── Worker pool ───────────────────────────────────────────────────────────────

async function runPool(nftIds, collectionId, onProgress) {
  const queue = [...nftIds];
  let allTransfers = [];
  let done = 0;
  let errors = 0;

  async function worker() {
    while (queue.length) {
      const nftId = queue.shift();
      try {
        const transfers = await walkNft(nftId, collectionId);
        allTransfers.push(...transfers);
      } catch { errors++; }
      done++;
      onProgress(done, nftIds.length, allTransfers.length, errors);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return allTransfers;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args  = process.argv.slice(2);
  const id    = args.find(a => !a.startsWith('--'));
  const fresh = args.includes('--fresh');

  if (!id) {
    console.error('Usage: node server/volume-backfill.js <collection_id> [--fresh]');
    process.exit(1);
  }

  // Load collection name
  const { data: col } = await supabase
    .from('indexed_collections').select('name').eq('collection_id', id).maybeSingle();
  console.log(`\nVolume backfill: ${col?.name || id}`);

  if (fresh) {
    console.log('  --fresh: wiping existing transfers...');
    await supabase.from('nft_transfers').delete().eq('collection_id', id);
  }

  // Load all NFT IDs for this collection (paginate past Supabase's 1000-row default)
  const nftIds = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('indexed_nfts').select('nft_id')
      .eq('collection_id', id).not('nft_id', 'is', null)
      .range(from, from + 999);
    if (error) { console.error('Supabase error:', error.message); process.exit(1); }
    if (!data?.length) break;
    nftIds.push(...data.map(n => n.nft_id));
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`  ${nftIds.length} NFTs to walk\n`);

  const startTime = Date.now();

  const transfers = await runPool(nftIds, id, (done, total, found, errs) => {
    const pct = Math.round(done / total * 100);
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const eta = done > 0 ? Math.round((elapsed / done) * (total - done)) : '?';
    process.stdout.write(
      `\r  [${pct}%] ${done}/${total} NFTs · ${found} transfers found · ${errs} errors · ETA ${eta}s   `
    );
  });

  console.log(`\n\n  ${transfers.length} total transfers to write`);

  if (!transfers.length) {
    console.log('  Nothing to insert.');
    return;
  }

  // Deduplicate by nft_id+block_height in JS (avoids needing a DB constraint)
  const seen = new Set();
  const deduped = transfers.filter(t => {
    const key = `${t.nft_id}:${t.block_height}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Insert in batches of 500
  let inserted = 0;
  for (let i = 0; i < deduped.length; i += 500) {
    const batch = deduped.slice(i, i + 500);
    const { error: insertErr } = await supabase.from('nft_transfers').insert(batch);
    if (insertErr) console.error('\n  Supabase error:', insertErr.message);
    else inserted += batch.length;
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const withPrice = transfers.filter(t => t.price_mojo).length;
  console.log(`  ${inserted} transfers inserted · ${withPrice} with price · ${elapsed}s elapsed`);
  console.log('\nDone.\n');
}

main().catch(e => { console.error(e); process.exit(1); });
