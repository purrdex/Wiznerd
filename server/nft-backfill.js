'use strict';
// On-chain NFT trait backfill for a single collection.
// Gets NFT IDs from MintGarden (discovery only), then fetches all data
// from the Chia blockchain + IPFS — no MintGarden data dependency.
//
// Usage: node server/nft-backfill.js <collection_id>
// Example: node server/nft-backfill.js col1apvkk4tz...

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const crypto = require('crypto');
const { bech32m } = require('bech32');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const PROXY      = process.env.PROXY_URL || 'http://localhost:3001';
const CONCURRENCY  = 2;     // parallel NFT lookups
const COIN_DELAY   = 200;   // ms between wallet RPC calls per worker
const MG_DELAY     = 1500;  // ms between MintGarden discovery pages
const MG_NFT_DELAY = 1200;  // ms between per-NFT MintGarden fetches per worker

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { realtime: { transport: ws } }
);

// ── RPC helpers ───────────────────────────────────────────────────────────────

async function nodeRpc(endpoint, body = {}) {
  const res = await fetch(`${PROXY}/${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`node ${endpoint}: HTTP ${res.status}`);
  return res.json();
}

async function walletRpc(endpoint, body = {}) {
  const res = await fetch(`${PROXY}/wallet/${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`wallet ${endpoint}: HTTP ${res.status}`);
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

// Decode nft1... encoded ID → raw hex launcher ID
function decodeLauncherId(encodedId) {
  try {
    const decoded = bech32m.decode(encodedId, 90);
    return Buffer.from(bech32m.fromWords(decoded.words)).toString('hex');
  } catch {
    return null;
  }
}

// ── Singleton chain walker ────────────────────────────────────────────────────
// Given a launcher ID (hex), walk the singleton spend chain to find
// the current unspent NFT coin ID.

async function getCurrentCoinId(launcherId) {
  let parentIds = [launcherId];

  for (let depth = 0; depth < 200; depth++) {
    const { coin_records } = await nodeRpc('get_coin_records_by_parent_ids', {
      parent_ids: parentIds.map(id => `0x${id}`),
      include_spent_coins: true,
    });

    if (!coin_records?.length) return null;

    // Filter to singleton-like coins (amount = 1 mojo)
    const singletons = coin_records.filter(r => BigInt(r.coin.amount) === 1n);
    if (!singletons.length) return null;

    const unspent = singletons.find(r => !r.spent);
    if (unspent) return coinId(unspent.coin);

    // All spent — follow to next generation
    parentIds = singletons.map(r => coinId(r.coin));
  }

  return null; // shouldn't happen for a valid NFT
}

// ── IPFS metadata fetch ───────────────────────────────────────────────────────

async function fetchMetadata(uri) {
  if (!uri) return null;
  const url = uri.startsWith('ipfs://')
    ? `https://gateway.pinata.cloud/ipfs/${uri.slice(7)}`
    : uri;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) return null;
    return res.json();
  } catch {
    return null;
  }
}

// ── Process one NFT ───────────────────────────────────────────────────────────

async function processNft(encodedId, collectionId) {
  const launcherId = decodeLauncherId(encodedId);
  if (!launcherId) { console.warn(`  skip: cannot decode ${encodedId}`); return; }

  // Walk singleton chain to find current coin
  const currentCoinId = await getCurrentCoinId(launcherId);
  if (!currentCoinId) {
    // Singleton chain terminated — NFT was burned. Mark it in DB so it's excluded from gallery.
    const BURN_PH = '0000000000000000000000000000000000000000000000000000000000000000';
    await supabase.from('indexed_nfts')
      .update({ owner_puzzle_hash: BURN_PH, updated_at: new Date().toISOString() })
      .eq('nft_id', encodedId);
    console.warn(`  skip: no current coin for ${encodedId} (marked burned)`);
    return;
  }

  // Ask wallet daemon to decode NFT state from that coin
  let info;
  try {
    const r = await walletRpc('nft_get_info', { coin_id: `0x${currentCoinId}` });
    if (!r.success || !r.nft_info) { console.warn(`  skip: nft_get_info failed for ${encodedId}`); return; }
    info = r.nft_info;
  } catch (e) {
    console.warn(`  skip: wallet RPC error for ${encodedId}: ${e.message}`);
    return;
  }

  const nftId       = info.launcher_id || info.nft_id || `0x${launcherId}`;
  const metadataUri = (info.metadata_uris || [])[0] || null;
  const imageUri    = (info.data_uris || [])[0] || null;
  const dataHash    = info.data_hash   || null;
  const metaHash    = info.metadata_hash || null;
  const minterDid   = info.minter_did  || null;
  const ownerPH     = info.p2_address  || null;

  const imageUrl = imageUri?.startsWith('ipfs://')
    ? `https://gateway.pinata.cloud/ipfs/${imageUri.slice(7)}`
    : imageUri || null;

  // Fetch CHIP-0007 metadata from IPFS — this is where traits live
  const meta = await fetchMetadata(metadataUri);

  const seriesNumber  = meta?.series_number ?? null;
  const nftName       = meta?.name || null;
  const traits        = meta?.attributes
    ? Object.fromEntries(meta.attributes.filter(a => a.trait_type).map(a => [a.trait_type, String(a.value)]))
    : {};

  const traitCount = Object.keys(traits).length;

  const upsertRow = {
    nft_id:            nftId,
    collection_id:     collectionId,
    token_index:       seriesNumber != null ? seriesNumber - 1 : null,
    name:              nftName,
    metadata_uri:      metadataUri,
    data_hash:         dataHash,
    meta_hash:         metaHash,
    owner_puzzle_hash: ownerPH,
    minter_did:        minterDid,
    traits,
    updated_at:        new Date().toISOString(),
  };
  // Only set image_url when we actually have one — don't overwrite cached MintGarden thumbnails with null
  if (imageUrl) upsertRow.image_url = imageUrl;

  await supabase.from('indexed_nfts').upsert(upsertRow, { onConflict: 'nft_id' });

  return traitCount;
}

// ── MintGarden-primary mode ───────────────────────────────────────────────────
// For collections where on-chain metadata_uris are absent (e.g. Meowfers),
// fetch everything from MintGarden's per-NFT API: traits, image, owner.

async function fetchMgNft(encodedId, retries = 4) {
  let delay = 2000;
  for (let i = 0; i <= retries; i++) {
    const res = await fetch(`https://api.mintgarden.io/nfts/${encodeURIComponent(encodedId)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 429) {
      if (i === retries) throw new Error(`429 after ${retries} retries for ${encodedId}`);
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
      continue;
    }
    return res;
  }
}

async function processNftFromMG(encodedId, collectionId) {
  await new Promise(r => setTimeout(r, MG_NFT_DELAY));
  const res = await fetchMgNft(encodedId);
  if (!res || !res.ok) return;
  const nft = await res.json();

  const meta = nft.data?.metadata_json || {};
  const dataUris = nft.data?.data_uris || [];

  const traits = Array.isArray(meta.attributes)
    ? Object.fromEntries(meta.attributes.filter(a => a.trait_type).map(a => [a.trait_type, String(a.value)]))
    : {};

  // Prefer MintGarden CDN thumbnail (fast) over raw IPFS URI (slow Pinata gateway)
  const ipfsUri = dataUris.find(u => u.startsWith('ipfs://')) || dataUris[0] || null;
  const ipfsUrl = ipfsUri?.startsWith('ipfs://')
    ? `https://gateway.pinata.cloud/ipfs/${ipfsUri.slice(7)}`
    : ipfsUri || null;
  const imageUrl = nft.data?.thumbnail_uri || ipfsUrl || null;

  const ownerPH  = nft.owner_address?.id || null;
  const nftId    = encodedId; // always bech32m — consistent with nft_transfers and live indexer
  const nftName  = meta.name || nft.name || null;
  const seriesNumber = meta.series_number ?? null;

  const { error: upsertErr } = await supabase.from('indexed_nfts').upsert({
    nft_id:            nftId,
    collection_id:     collectionId,
    token_index:       seriesNumber != null ? seriesNumber - 1 : null,
    name:              nftName,
    metadata_uri:      null,
    image_url:         imageUrl,
    data_hash:         nft.data?.data_hash || null,
    owner_puzzle_hash: ownerPH,
    traits,
    updated_at:        new Date().toISOString(),
  }, { onConflict: 'nft_id' });

  if (upsertErr) throw new Error(`Supabase: ${upsertErr.message}`);
  return Object.keys(traits).length;
}

async function backfillCollectionFromMG(collectionId) {
  console.log(`\n── ${collectionId} (MintGarden source) ──`);
  process.stdout.write('  Collecting NFT IDs from MintGarden...');

  const nftIds = [];
  try {
    for await (const id of getAllNftIds(collectionId)) {
      nftIds.push(id);
      if (nftIds.length % 100 === 0) process.stdout.write(`\r  Found ${nftIds.length} NFTs...   `);
    }
  } catch (e) {
    if (!nftIds.length) {
      console.warn(`\n  MintGarden discovery failed: ${e.message} — skipping`);
      return;
    }
    console.warn(`\n  Discovery stopped at ${nftIds.length} NFTs (${e.message}) — processing what we have`);
  }
  const uniqueIds = [...new Set(nftIds)];
  console.log(`\r  ${uniqueIds.length} unique NFTs to index (${nftIds.length} discovered)`);
  if (!uniqueIds.length) { console.log('  Nothing to index.'); return; }

  process.stdout.write('  Fetching per-NFT metadata from MintGarden...\n  ');
  const { done, withTraits, errors } = await runWithConcurrency(
    uniqueIds,
    id => processNftFromMG(id, collectionId),
    CONCURRENCY
  );
  console.log(`\n  Done: ${done} processed · ${withTraits} with traits · ${errors} errors`);
}

// ── MintGarden NFT ID discovery ───────────────────────────────────────────────
// Only used to get the list of NFT IDs — no trait data from here.

async function* getAllNftIds(collectionId, maxItems = 60000) {
  let cursor = null;
  let page = 0;
  let totalYielded = 0;
  const seenCursors = new Set();

  while (true) {
    const url = cursor
      ? `https://api.mintgarden.io/collections/${encodeURIComponent(collectionId)}/nfts?size=48&page=${encodeURIComponent(cursor)}`
      : `https://api.mintgarden.io/collections/${encodeURIComponent(collectionId)}/nfts?size=48`;

    let res, retryDelay = 8000;
    for (let attempt = 0; attempt < 10; attempt++) {
      res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (res.status !== 429) break;
      process.stdout.write(`\n  429 on discovery page ${page} — waiting ${retryDelay / 1000}s...`);
      await new Promise(r => setTimeout(r, retryDelay));
      retryDelay = Math.min(retryDelay * 2, 120000);
    }
    if (!res.ok) throw new Error(`MintGarden HTTP ${res.status} on page ${page}`);
    const json = await res.json();

    const ids = (json.items || []).map(n => n.encoded_id).filter(Boolean);
    if (!ids.length) break; // empty page = done

    yield* ids;
    totalYielded += ids.length;
    if (totalYielded % 500 === 0) process.stdout.write(`\r  Scanned ${totalYielded} IDs...   `);

    if (totalYielded >= maxItems) { console.warn(`\n  Hit max ${maxItems} — stopping discovery`); break; }
    if (!json.next) break;
    if (seenCursors.has(json.next)) { console.warn('\n  Circular pagination detected — stopping'); break; }
    seenCursors.add(json.next);
    cursor = json.next;
    page++;
    await new Promise(r => setTimeout(r, MG_DELAY));
  }
}

// ── Worker pool ───────────────────────────────────────────────────────────────

async function runWithConcurrency(items, fn, concurrency) {
  const queue = [...items];
  let done = 0, withTraits = 0, errors = 0;
  const total = items.length;

  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      try {
        const traitCount = await fn(item);
        if (traitCount > 0) withTraits++;
        done++;
        if (done % 10 === 0 || done === total) {
          process.stdout.write(`\r  [${done}/${total}] indexed · ${withTraits} with traits · ${errors} errors`);
        }
      } catch (e) {
        errors++;
        done++;
        if (errors <= 3) console.error(`\n  ERROR [${item}]: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, COIN_DELAY));
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return { done, withTraits, errors };
}

// ── Per-collection backfill ───────────────────────────────────────────────────

async function backfillCollection(collectionId) {
  console.log(`\n── ${collectionId} ──`);
  process.stdout.write('  Collecting NFT IDs from MintGarden...');

  const nftIds = [];
  try {
    for await (const id of getAllNftIds(collectionId)) {
      nftIds.push(id);
      if (nftIds.length % 100 === 0) process.stdout.write(`\r  Found ${nftIds.length} NFTs...   `);
    }
  } catch (e) {
    console.warn(`\n  MintGarden discovery failed: ${e.message} — skipping`);
    return;
  }
  console.log(`\r  ${nftIds.length} NFTs to index`);

  if (!nftIds.length) { console.log('  Nothing to index.'); return; }

  process.stdout.write('  Fetching on-chain data (singleton walk + wallet daemon + IPFS)...\n  ');
  const { done, withTraits, errors } = await runWithConcurrency(
    nftIds,
    id => processNft(id, collectionId),
    CONCURRENCY
  );
  console.log(`\n  Done: ${done} processed · ${withTraits} with traits · ${errors} errors`);
}

// ── Ownership-only refresh (fast) ─────────────────────────────────────────────
// Pages through the MintGarden collection listing (which already includes
// owner_address_encoded_id for each NFT) and batch-upserts owner_puzzle_hash.
// No per-NFT API calls — ~48 NFTs per HTTP request. Suitable for nightly cron.

async function refreshOwnershipFromMG(collectionId, collName) {
  process.stdout.write(`  [${collName || collectionId.slice(0, 20)}] refreshing ownership...`);
  let cursor = null;
  let updated = 0;
  let pages = 0;

  while (true) {
    const url = cursor
      ? `https://api.mintgarden.io/collections/${encodeURIComponent(collectionId)}/nfts?size=48&page=${encodeURIComponent(cursor)}`
      : `https://api.mintgarden.io/collections/${encodeURIComponent(collectionId)}/nfts?size=48`;

    let res;
    let retryDelay = 5000;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      } catch (e) {
        if (attempt === 4) throw e;
        await new Promise(r => setTimeout(r, retryDelay));
        retryDelay = Math.min(retryDelay * 2, 30000);
        continue;
      }
      if (res.status !== 429) break;
      process.stdout.write(` [429, waiting ${retryDelay / 1000}s]`);
      await new Promise(r => setTimeout(r, retryDelay));
      retryDelay = Math.min(retryDelay * 2, 60000);
    }
    if (!res || !res.ok) { process.stdout.write(` HTTP ${res?.status} — skip\n`); return updated; }

    const json = await res.json();
    const items = json.items || [];
    if (!items.length) break;

    const batch = [];
    for (const item of items) {
      if (!item.encoded_id || !item.owner_address_encoded_id) continue;
      try {
        const d = bech32m.decode(item.owner_address_encoded_id, 90);
        const ph = Buffer.from(bech32m.fromWords(d.words)).toString('hex');
        batch.push({ nft_id: item.encoded_id, collection_id: collectionId, owner_puzzle_hash: ph, updated_at: new Date().toISOString() });
      } catch { /* skip invalid address */ }
    }

    if (batch.length) {
      const { error } = await supabase.from('indexed_nfts')
        .upsert(batch, { onConflict: 'nft_id' });
      if (error) process.stdout.write(` [db error: ${error.message}]`);
      else updated += batch.length;
    }

    pages++;
    if (!json.next) break;
    cursor = json.next;
    await new Promise(r => setTimeout(r, MG_DELAY));
  }

  process.stdout.write(` ${updated} updated (${pages} pages)\n`);
  return updated;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const flags = { all: false, minCount: 0, maxCount: 0, id: null, slug: null, mg: false, ownership: false, missingOwnership: false, missing: false, test: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--all') flags.all = true;
    else if (args[i] === '--mg') flags.mg = true;
    else if (args[i] === '--ownership') flags.ownership = true;
    else if (args[i] === '--missing-ownership') flags.missingOwnership = true;
    else if (args[i] === '--missing') flags.missing = true;
    else if (args[i] === '--test') flags.test = true;
    else if (args[i] === '--slug' && args[i + 1]) { flags.slug = args[++i]; }
    else if (args[i] === '--min-count' && args[i + 1]) { flags.minCount = parseInt(args[++i], 10); }
    else if (args[i] === '--max-count' && args[i + 1]) { flags.maxCount = parseInt(args[++i], 10); }
    else if (!args[i].startsWith('--')) flags.id = args[i];
  }
  return flags;
}

async function main() {
  const flags = parseArgs();

  let collectionIds;

  if (flags.all) {
    console.log('Loading collections from indexed_collections...');
    let query = supabase
      .from('indexed_collections')
      .select('collection_id, name, minted_count')
      .order('minted_count', { ascending: false });

    if (flags.minCount > 0) query = query.gte('minted_count', flags.minCount);
    if (flags.maxCount > 0) query = query.lte('minted_count', flags.maxCount);

    const { data, error } = await query;
    if (error) { console.error('Supabase error:', error.message); process.exit(1); }

    collectionIds = (data || []).map(c => ({ id: c.collection_id, name: c.name, count: c.minted_count }));
    const totalNfts = collectionIds.reduce((s, c) => s + (c.count || 0), 0);

    const countLabel = [flags.minCount ? `≥ ${flags.minCount}` : '', flags.maxCount ? `≤ ${flags.maxCount}` : ''].filter(Boolean).join(', ');
    console.log(`\n${collectionIds.length} collections${countLabel ? ` (${countLabel} NFTs)` : ''} · ${totalNfts.toLocaleString()} total NFTs\n`);
    collectionIds.forEach((c, i) => console.log(`  ${String(i + 1).padStart(4)}. ${c.name.padEnd(40)} ${String(c.count).padStart(6)} NFTs`));

    const estMinutes = Math.round(totalNfts / CONCURRENCY / (1000 / COIN_DELAY) / 60);
    console.log(`\nEstimated time: ~${estMinutes} minutes at ${CONCURRENCY} workers`);
    console.log('Starting in 5 seconds — Ctrl+C to abort...\n');
    await new Promise(r => setTimeout(r, 5000));
  } else if (flags.id) {
    collectionIds = [{ id: flags.id, name: flags.id, count: '?' }];
  } else if (!flags.missingOwnership && !flags.missing) {
    console.error('Usage:');
    console.error('  node server/nft-backfill.js <collection_id>             # on-chain singleton walk');
    console.error('  node server/nft-backfill.js <collection_id> --mg        # MintGarden source');
    console.error('  node server/nft-backfill.js --all --min-count 500       # on-chain, all large collections');
    console.error('  node server/nft-backfill.js --all --mg                  # MintGarden source, all collections');
    console.error('  node server/nft-backfill.js --all --ownership           # fast: ownership refresh only (nightly cron)');
    console.error('  node server/nft-backfill.js --missing                   # retry all collections with incomplete NFTs');
    console.error('  node server/nft-backfill.js <collection_id> --missing   # retry only incomplete NFTs in one collection');
    console.error('  node server/nft-backfill.js <collection_id> --missing --mg  # same, MintGarden source');
    console.error('  node server/nft-backfill.js --missing-ownership         # retry collections with NULL owner_puzzle_hash');
    process.exit(1);
  }

  // --test: fetch first NFT ID from MintGarden, dump raw response, try one upsert
  if (flags.test && flags.id) {
    console.log('\n── TEST MODE — one NFT ──');
    const firstPage = await fetch(
      `https://api.mintgarden.io/collections/${encodeURIComponent(flags.id)}/nfts?size=1`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) }
    );
    const pg = await firstPage.json();
    const encodedId = pg.items?.[0]?.encoded_id;
    if (!encodedId) { console.error('No NFTs returned from MintGarden'); process.exit(1); }
    console.log('encoded_id:', encodedId);

    const nftRes = await fetch(`https://api.mintgarden.io/nfts/${encodeURIComponent(encodedId)}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    console.log('MG status:', nftRes.status);
    const nft = await nftRes.json();
    console.log('Top-level keys:', Object.keys(nft));
    console.log('nft.id:', nft.id);
    console.log('nft.data keys:', nft.data ? Object.keys(nft.data) : 'no data');
    console.log('metadata_json:', JSON.stringify(nft.data?.metadata_json, null, 2)?.slice(0, 400));
    console.log('owner_address:', nft.owner_address);

    const meta = nft.data?.metadata_json || {};
    const traits = Array.isArray(meta.attributes)
      ? Object.fromEntries(meta.attributes.filter(a => a.trait_type).map(a => [a.trait_type, String(a.value)]))
      : {};
    console.log('traits parsed:', traits);

    const nftId = nft.id ? `0x${nft.id}` : encodedId;
    const { error } = await supabase.from('indexed_nfts').upsert({
      nft_id: nftId, collection_id: flags.id, traits,
      owner_puzzle_hash: nft.owner_address?.id || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'nft_id' });
    if (error) console.error('Supabase upsert error:', error);
    else console.log('Supabase upsert OK — check DB for nft_id:', nftId);
    return;
  }

  if (flags.ownership) {
    let totalUpdated = 0;
    for (const col of collectionIds) {
      totalUpdated += await refreshOwnershipFromMG(col.id, col.name);
    }
    console.log(`\nOwnership refresh complete — ${totalUpdated} NFTs updated.`);
    process.exit(0);
  }

  if (flags.missingOwnership) {
    console.log('Querying for collections with missing owner_puzzle_hash...');
    const { data, error } = await supabase
      .from('indexed_nfts')
      .select('collection_id')
      .is('owner_puzzle_hash', null)
      .not('collection_id', 'is', null);
    if (error) { console.error('Supabase error:', error.message); process.exit(1); }
    const ids = [...new Set((data || []).map(r => r.collection_id))];
    console.log(`${ids.length} collections have NFTs missing ownership.\n`);
    if (!ids.length) { console.log('Nothing to do.'); process.exit(0); }
    let totalUpdated = 0;
    for (const id of ids) {
      totalUpdated += await refreshOwnershipFromMG(id, id.slice(0, 20));
    }
    console.log(`\nDone — ${totalUpdated} NFTs updated across ${ids.length} collections.`);
    process.exit(0);
  }

  if (flags.missing) {
    if (flags.id) {
      // Single collection --missing:
      // 1. Find partially-indexed rows (in DB but missing image/traits)
      // 2. Find never-inserted rows (compare DB count vs indexed_collections.minted_count)
      // 3. Process the union of both — skip full MintGarden paginate unless counts differ

      // Step 1: null/empty-field rows already in DB
      const { data: incompleteRows, error: incErr } = await supabase
        .from('indexed_nfts')
        .select('nft_id')
        .eq('collection_id', flags.id)
        .or('image_url.is.null,traits.is.null,traits.eq.{}');
      if (incErr) { console.error('Supabase error:', incErr.message); process.exit(1); }
      const incompleteIds = new Set((incompleteRows || []).map(r => r.nft_id).filter(Boolean));

      // Step 2: detect never-inserted rows by comparing counts
      const [{ count: dbCount }, { data: colInfo }] = await Promise.all([
        supabase.from('indexed_nfts').select('*', { count: 'exact', head: true }).eq('collection_id', flags.id),
        supabase.from('indexed_collections').select('minted_count, total_supply, name').eq('collection_id', flags.id).maybeSingle(),
      ]);
      const mintedCount = colInfo?.minted_count ?? 0;
      const totalSupply = colInfo?.total_supply ?? mintedCount;
      const gap = mintedCount - (dbCount ?? 0);
      console.log(`DB: ${dbCount ?? '?'} rows  ·  minted: ${mintedCount}  ·  total supply: ${totalSupply}  ·  gap: ${Math.max(0, gap)}  ·  incomplete fields: ${incompleteIds.size}`);

      let toProcess = [...incompleteIds];

      if (gap > 0) {
        // Extract numbers from name field (e.g. "Meowfers #412" → 412)
        // Must paginate — Supabase caps at 1000 rows per query
        console.log(`\nGap detected — finding missing token numbers from name field...`);
        const haveNumbers = new Set();
        let namePage = 0;
        while (true) {
          const { data: nameRows } = await supabase
            .from('indexed_nfts').select('name')
            .eq('collection_id', flags.id).not('name', 'is', null)
            .range(namePage * 1000, namePage * 1000 + 999);
          if (!nameRows || !nameRows.length) break;
          for (const row of nameRows) {
            const m = row.name && row.name.match(/#(\d+)/);
            if (m) haveNumbers.add(parseInt(m[1], 10));
          }
          if (nameRows.length < 1000) break;
          namePage++;
        }
        process.stdout.write(`\n`);

        // Upper bound: max number seen across all names (burned NFTs live anywhere in 1..max)
        const maxSeen = haveNumbers.size > 0 ? Math.max(...haveNumbers) : mintedCount;
        const upperBound = Math.max(totalSupply || 0, maxSeen);
        const missingNumbers = [];
        for (let n = 1; n <= upperBound; n++) {
          if (!haveNumbers.has(n)) missingNumbers.push(n);
        }
        // missingNumbers = (burned NFTs) + (never-indexed NFTs); MintGarden search will 404 burned ones
        console.log(`  Have names for ${haveNumbers.size} NFTs (upper bound: ${upperBound}). Gap numbers: ${missingNumbers.slice(0, 20).join(', ')}${missingNumbers.length > 20 ? ` ... (${missingNumbers.length} total)` : ''}`);

        if (missingNumbers.length > 0 && missingNumbers.length <= upperBound * 0.1) {
          // Search MintGarden for each missing number by name to get its encoded_id
          // Scan collection listing, match by name, stop as soon as we've found `gap` NFTs
          const missingNumberSet = new Set(missingNumbers);
          const neverInserted = [];
          let pages = 0, cursor = null;
          console.log(`  Scanning collection listing — will stop after finding ${gap} NFTs...\n`);
          outer: while (true) {
            const url = cursor
              ? `https://api.mintgarden.io/collections/${encodeURIComponent(flags.id)}/nfts?size=48&page=${encodeURIComponent(cursor)}`
              : `https://api.mintgarden.io/collections/${encodeURIComponent(flags.id)}/nfts?size=48`;
            let res, retryDelay = 8000;
            for (let attempt = 0; attempt < 10; attempt++) {
              res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
              if (res.status !== 429) break;
              process.stdout.write(`\n  429 — waiting ${retryDelay / 1000}s...`);
              await new Promise(r => setTimeout(r, retryDelay));
              retryDelay = Math.min(retryDelay * 2, 120000);
            }
            if (!res.ok) { console.warn(`\n  HTTP ${res.status} on page ${pages}`); break; }
            const json = await res.json();
            for (const item of (json.items || [])) {
              const m = item.name && item.name.match(/#(\d+)/);
              if (m && missingNumberSet.has(parseInt(m[1], 10))) {
                const n = parseInt(m[1], 10);
                neverInserted.push(item.encoded_id);
                missingNumberSet.delete(n);
                console.log(`  Found #${n} → ${item.encoded_id}  (${neverInserted.length}/${gap})`);
                if (neverInserted.length >= gap) { console.log(`\n  Found all ${gap} — stopping early at page ${pages}.`); break outer; }
              }
            }
            pages++;
            process.stdout.write(`\r  Page ${pages} scanned — found ${neverInserted.length}/${gap} so far...`);
            if (!json.next) break;
            cursor = json.next;
            await new Promise(r => setTimeout(r, MG_DELAY));
          }
          console.log(`\n  Scanned ${pages} pages, found ${neverInserted.length} NFTs to process.`);
          for (const id of neverInserted) { if (!incompleteIds.has(id)) toProcess.push(id); }
        } else {
          // Fallback: page through MintGarden collection listing
          console.log(`  Too many missing numbers (${missingNumbers.length}) — falling back to full MintGarden listing.`);
          const { data: allRows } = await supabase
            .from('indexed_nfts').select('nft_id').eq('collection_id', flags.id);
          const dbSet = new Set((allRows || []).map(r => r.nft_id));
          const mgIds = [];
          for await (const id of getAllNftIds(flags.id)) mgIds.push(id);
          const neverInserted = mgIds.filter(id => !dbSet.has(id));
          console.log(`  Found ${neverInserted.length} never-inserted NFTs.`);
          for (const id of neverInserted) { if (!incompleteIds.has(id)) toProcess.push(id); }
        }
      }

      console.log(`\n${toProcess.length} NFTs to process.\n`);
      if (!toProcess.length) { console.log('Nothing to do.'); process.exit(0); }

      const processFn = flags.mg
        ? id => processNftFromMG(id, flags.id)
        : id => processNft(id, flags.id);
      const { done, withTraits, errors } = await runWithConcurrency(toProcess, processFn, CONCURRENCY);
      console.log(`\nDone: ${done} processed · ${withTraits} with traits · ${errors} errors`);
      process.exit(0);
    }

    // No collection ID: find all collections with incomplete NFTs
    console.log('Querying for collections with incomplete NFTs (missing traits or image)...');
    const { data, error } = await supabase
      .from('indexed_nfts')
      .select('collection_id')
      .not('collection_id', 'is', null)
      .or('image_url.is.null,traits.is.null');
    if (error) { console.error('Supabase error:', error.message); process.exit(1); }
    const incompleteIds = [...new Set((data || []).map(r => r.collection_id))];
    console.log(`${incompleteIds.length} collections have incomplete NFTs.\n`);
    if (!incompleteIds.length) { console.log('Nothing to do.'); process.exit(0); }

    const { data: colRows } = await supabase
      .from('indexed_collections')
      .select('collection_id, name, minted_count')
      .in('collection_id', incompleteIds);
    const colMap = Object.fromEntries((colRows || []).map(c => [c.collection_id, c]));
    const cols = incompleteIds.map(id => ({
      id,
      name: colMap[id]?.name || id.slice(0, 20),
      count: colMap[id]?.minted_count || '?',
    }));
    cols.forEach((c, i) => console.log(`  ${String(i + 1).padStart(4)}. ${c.name.padEnd(40)} ${String(c.count).padStart(6)} NFTs`));
    console.log('\nStarting in 3 seconds — Ctrl+C to abort...\n');
    await new Promise(r => setTimeout(r, 3000));

    const runFn = flags.mg ? backfillCollectionFromMG : backfillCollection;
    for (const col of cols) {
      await runFn(col.id);
    }
    console.log(`\nDone — retried ${cols.length} collections.`);
    process.exit(0);
  }

  const runFn = flags.mg ? backfillCollectionFromMG : backfillCollection;

  for (const col of collectionIds) {
    await runFn(col.id);
  }

  console.log('\n\nAll done. Trait filtering is now available via Supabase JSONB.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
