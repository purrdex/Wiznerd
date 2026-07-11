'use strict';
// Dexie CAT trade backfill — fetches completed XCH/CAT offers from Dexie
// for every token in cat_tokens, inserts into cat_transfers.
//
// Usage:
//   node server/cat-backfill.js                      # all tokens
//   node server/cat-backfill.js <asset_id>           # single token
//   node server/cat-backfill.js --since 2026-01-01   # only recent trades
//   node server/cat-backfill.js --fresh              # wipe first

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabase  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { realtime: { transport: ws } });
const DEXIE_API = 'https://api.dexie.space/v1';
const PAGE_SIZE = 500;
const PAGE_DELAY = 300;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchPage(assetId, page) {
  const url = `${DEXIE_API}/offers?offered_or_requested=${assetId}&status=4&compact=true&page_size=${PAGE_SIZE}&page=${page}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Dexie HTTP ${res.status}`);
  return res.json();
}

// Parse a single Dexie offer involving a CAT token and return a cat_transfer row.
// Returns null if the offer isn't an XCH/CAT pair or can't be parsed.
function parseOffer(offer, assetId) {
  const off = offer.offered?.[0];
  const req = offer.requested?.[0];
  if (!off || !req) return null;

  const offId = (off.id || '').toLowerCase();
  const reqId = (req.id || '').toLowerCase();
  const assetLow = assetId.toLowerCase();

  // Dexie compact=true returns amounts in human-readable units (XCH, not mojos;
  // tokens, not token-mojos). The `price` field means:
  //   sell side (CAT→XCH): XCH per token  ← use directly
  //   buy  side (XCH→CAT): tokens per XCH ← invert to get XCH per token
  let xchAmount    = null;
  let tokenAmount  = null;
  let priceXch     = null;

  // CAT sold for XCH: offered=CAT, requested=XCH
  if (offId === assetLow && reqId === 'xch') {
    tokenAmount = off.amount != null ? Number(off.amount) : null;
    xchAmount   = req.amount != null ? Number(req.amount) : null;
    priceXch    = offer.price != null ? Number(offer.price) : null;

  // XCH paid for CAT: offered=XCH, requested=CAT
  } else if (offId === 'xch' && reqId === assetLow) {
    tokenAmount = req.amount != null ? Number(req.amount) : null;
    xchAmount   = off.amount != null ? Number(off.amount) : null;
    // price = tokens per XCH on buy side — invert to get XCH per token
    const rawPrice = offer.price != null ? Number(offer.price) : null;
    priceXch    = rawPrice != null && rawPrice > 0 ? 1 / rawPrice : null;

  } else {
    return null; // CAT-CAT swap or unrelated
  }

  if (priceXch == null && tokenAmount && xchAmount) {
    priceXch = tokenAmount > 0 ? xchAmount / tokenAmount : null;
  }

  const volumeXch = xchAmount;

  return {
    asset_id:       assetId,
    offer_id:       offer.id || null,
    price_xch:      priceXch,
    amount_tokens:  tokenAmount,
    volume_xch:     volumeXch,
    block_height:   offer.spent_block_index || null,
    transferred_at: offer.date_completed || new Date().toISOString(),
    source:         'dexie',
  };
}

async function backfillToken(assetId, shortName, sinceDate) {
  let first;
  try { first = await fetchPage(assetId, 1); }
  catch (e) { console.log(`  [${shortName}] Dexie error: ${e.message}`); return 0; }

  const total = first.count || 0;
  const pages = Math.ceil(total / PAGE_SIZE);
  if (!total) { return 0; }

  const seen = new Set();
  let totalInserted = 0;

  async function processPage(d) {
    let rows = [];
    for (const offer of d.offers || []) {
      const row = parseOffer(offer, assetId);
      if (!row || !row.price_xch) continue;

      if (sinceDate && row.transferred_at < sinceDate) return { done: true };

      const key = row.offer_id || `${assetId}:${row.block_height}:${row.transferred_at}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }

    if (!rows.length) return;

    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const { error } = await supabase.from('cat_transfers').insert(batch);
      if (!error) {
        totalInserted += batch.length;
      } else if (error.code === '23505' || error.message?.includes('unique') || error.message?.includes('duplicate')) {
        // Unique violation — insert one by one, skip already-present rows
        for (const row of batch) {
          const { error: e2 } = await supabase.from('cat_transfers').insert(row);
          if (!e2) totalInserted++;
          // ignore individual duplicate errors silently
        }
      } else {
        console.error(`  insert error: ${error.message}`);
      }
    }
  }

  const firstResult = await processPage(first);
  if (firstResult?.done) return totalInserted;

  for (let page = 2; page <= pages; page++) {
    await sleep(PAGE_DELAY);
    let d;
    try { d = await fetchPage(assetId, page); }
    catch (e) { console.error(`  page ${page} error: ${e.message} — skipping`); continue; }
    const result = await processPage(d);
    process.stdout.write(`\r  [${shortName}] ${page}/${pages} pages · ${totalInserted} trades`);
    if (result?.done) break;
  }

  if (pages > 1) process.stdout.write('\n');
  return totalInserted;
}

async function main() {
  const args      = process.argv.slice(2);
  const fresh     = args.includes('--fresh');
  const sinceIdx  = args.indexOf('--since');
  const sinceDate = sinceIdx !== -1 ? args[sinceIdx + 1] : null;
  const skipNext  = new Set(sinceIdx !== -1 ? [sinceIdx + 1] : []);
  const singleId  = args.find((a, i) => !a.startsWith('--') && !skipNext.has(i)) || null;

  if (sinceDate) console.log(`--since ${sinceDate}: stopping per token once older trades are hit`);

  if (fresh) {
    const q = singleId
      ? supabase.from('cat_transfers').delete().eq('source', 'dexie').eq('asset_id', singleId)
      : supabase.from('cat_transfers').delete().eq('source', 'dexie');
    const { error } = await q;
    if (error) console.error('Fresh wipe error:', error.message);
    else console.log('--fresh: wiped existing dexie cat_transfers');
  }

  let tokens;
  if (singleId) {
    const { data } = await supabase.from('cat_tokens').select('asset_id, short_name').eq('asset_id', singleId).maybeSingle();
    tokens = [{ asset_id: singleId, short_name: data?.short_name || singleId.slice(0, 8) }];
  } else {
    const { data, error } = await supabase.from('cat_tokens').select('asset_id, short_name').order('asset_id');
    if (error) { console.error('Supabase error:', error.message); process.exit(1); }
    tokens = data || [];
  }

  console.log(`\nCAT backfill — ${tokens.length} token(s)\n`);

  let grandTotal = 0;
  for (let i = 0; i < tokens.length; i++) {
    const { asset_id, short_name } = tokens[i];
    const label = (short_name || asset_id).slice(0, 12);
    process.stdout.write(`  [${i + 1}/${tokens.length}] ${label.padEnd(12)} …`);

    const inserted = await backfillToken(asset_id, label, sinceDate);
    grandTotal += inserted;

    if (inserted > 0) console.log(`  ✓ ${inserted} trades`);
    else process.stdout.write(' 0\n');

    if (i < tokens.length - 1) await sleep(500);
  }

  console.log(`\nAll done. ${grandTotal} total CAT trades inserted.\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
