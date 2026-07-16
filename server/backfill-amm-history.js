'use strict';
// Historical AMM backfill — walks Tibet pair coin chains backwards,
// decodes CLVM puzzle reveals to extract per-swap reserve states,
// and inserts individual swap events into cat_transfers.
//
// Each backward step: getCoinRecord → getBlockTimestamp → getPuzzleAndSolution
// Delta between consecutive reserve states = one swap event.
// offer_id = 'amm:<coinId>' guarantees dedup across re-runs.
//
// Usage:
//   node server/backfill-amm-history.js                   # all pairs, last 30 days
//   node server/backfill-amm-history.js <asset_id>        # single token
//   node server/backfill-amm-history.js --days 90         # last 90 days
//   node server/backfill-amm-history.js --days 0          # full history

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabase  = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { realtime: { transport: ws } },
);

const PROXY        = process.env.PROXY_URL || 'http://localhost:3001';
const TIBET_API    = 'https://api.v2.tibetswap.io';
const RPC_DELAY_MS = 80;    // between node RPC calls
const MAX_STEPS    = 50000; // per-pair safety limit
const BATCH_SIZE   = 50;    // rows per DB insert

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function hexNorm(h) { return (h || '').replace(/^0x/i, '').toLowerCase(); }

// ── Node RPC ──────────────────────────────────────────────────────────────────

async function nodeRpc(endpoint, body = {}) {
  const res = await fetch(`${PROXY}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`node RPC ${endpoint}: HTTP ${res.status}`);
  const json = await res.json();
  if (!json.success) throw new Error(`node RPC ${endpoint}: ${json.error || 'failed'}`);
  return json;
}

const tsCache = new Map();  // block_height → ISO string

async function getBlockTimestamp(height) {
  if (tsCache.has(height)) return tsCache.get(height);
  const { block_record } = await nodeRpc('get_block_record_by_height', { height });
  const ts = block_record?.timestamp
    ? new Date(Number(block_record.timestamp) * 1000).toISOString()
    : null;
  if (ts) tsCache.set(height, ts);
  return ts;
}

// ── CLVM deserializer ─────────────────────────────────────────────────────────

class CLVMNode {
  constructor(value) {
    // value: Buffer (atom) or [CLVMNode, CLVMNode] (cons pair)
    if (Array.isArray(value)) {
      this._pair = value;
      this._atom = null;
    } else {
      this._atom = value;
      this._pair = null;
    }
  }

  get isCons() { return this._pair !== null; }
  get isAtom() { return this._atom !== null; }

  first() {
    if (!this._pair) throw new Error('first() on atom');
    return this._pair[0];
  }
  rest() {
    if (!this._pair) throw new Error('rest() on atom');
    return this._pair[1];
  }

  at(path) {
    let node = this;
    for (const ch of path) {
      if (ch === 'f') node = node.first();
      else if (ch === 'r') node = node.rest();
      else throw new Error(`bad path char: ${ch}`);
    }
    return node;
  }

  toInt() {
    if (!this._atom || !this._atom.length) return 0;
    let val = BigInt(0);
    for (const b of this._atom) val = (val << 8n) | BigInt(b);
    // signed interpretation (reserves are positive, but handle sign bit)
    if (this._atom[0] & 0x80) val -= 1n << BigInt(this._atom.length * 8);
    return Number(val);
  }

  toUInt() {
    // Unsigned — reserves are always positive
    if (!this._atom || !this._atom.length) return 0;
    let val = BigInt(0);
    for (const b of this._atom) val = (val << 8n) | BigInt(b);
    return Number(val);
  }
}

const NIL = new CLVMNode(Buffer.alloc(0));
function cons(a, b) { return new CLVMNode([a, b]); }

// Chia uses clvm_rs serialization:
//   0x00-0x7F  → single-byte atom; the byte itself IS the sole content
//   0x80       → nil (empty atom)
//   0x81-0xFE  → multi-byte atom; leading-1-bits in the byte count header bytes:
//                 1 leading bit (0x81-0xBF): size = b & 0x3F, read size data bytes
//                 2 leading bits (0xC0-0xDF): read 1 more header byte, size = ((b&0x1F)<<8)|b2
//                 3 leading bits (0xE0-0xEF): read 2 more header bytes, etc.
//   0xFF       → cons pair

function parseCLVM(hexOrBuf) {
  const buf = Buffer.isBuffer(hexOrBuf)
    ? hexOrBuf
    : Buffer.from(hexOrBuf.replace(/^0x/i, ''), 'hex');
  let pos = 0;

  function read() {
    if (pos >= buf.length) throw new Error('unexpected end of CLVM');
    const b = buf[pos++];

    if (b === 0xFF) {
      const left  = read();
      const right = read();
      return new CLVMNode([left, right]);
    }

    // Atom
    if (b < 0x80) {
      // Single-byte atom: the byte value IS the content (opcodes 1,2,4 etc. live here)
      return new CLVMNode(Buffer.from([b]));
    }
    if (b === 0x80) {
      return NIL; // nil
    }

    // Multi-byte atom: count leading 1-bits to determine extra header bytes
    let bits = 0, mask = 0x80;
    while (b & mask) { bits++; mask >>= 1; }
    let size = b & (0xFF >> (bits + 1));
    for (let i = 1; i < bits; i++) size = (size << 8) | buf[pos++];

    const data = buf.slice(pos, pos + size);
    pos += size;
    return new CLVMNode(Buffer.from(data));
  }

  return read();
}

// ── Uncurry ───────────────────────────────────────────────────────────────────
// Curry form: (a (q . inner) (c (q . arg1) (c (q . arg2) ... 1 ...)))
// opcodes:    2    1               4    1         4    1
// Returns { inner, argList } where argList is a CLVM cons chain of raw arg values,
// or null if not a valid curry.

function uncurry(node) {
  try {
    if (!node.isCons) return null;
    if (node.first().toInt() !== 2) return null;            // 'a' opcode

    const qInner = node.rest().first();                     // (q . inner)
    if (!qInner.isCons || qInner.first().toInt() !== 1) return null;
    const inner = qInner.rest();

    // env term: node = cons(2, cons((q.inner), cons(env, nil)))
    // so node.rest().rest() = cons(env, nil)
    if (!node.rest().rest().isCons) return null;
    let env = node.rest().rest().first();

    const args = [];
    while (env.isCons && env.first().toInt() === 4) {      // 'c' opcode
      // env = cons(4, cons((q.argN), cons(next_env, nil)))
      const envRest = env.rest();
      if (!envRest.isCons) break;
      const qArg = envRest.first();                         // (q . argN)
      if (!qArg.isCons || qArg.first().toInt() !== 1) break;
      args.push(qArg.rest());                               // raw arg value

      if (!envRest.rest().isCons) break;
      env = envRest.rest().first();                         // next env node
    }

    // Build proper CLVM list (arg0 . (arg1 . (arg2 . nil)))
    let argList = NIL;
    for (let i = args.length - 1; i >= 0; i--) argList = cons(args[i], argList);

    return { inner, argList };
  } catch {
    return null;
  }
}

// ── Reserve extraction ────────────────────────────────────────────────────────
// TibetSwap v2 pair path:
//   puzzle_reveal
//     .uncurry().argList.at('rf')      → inner AMM puzzle (2nd outer curried arg)
//     .uncurry().argList.at('rrf')     → state tuple (3rd inner curried arg)
//   state = (liquidity . (xch_reserve . token_reserve))
//   xch_reserve   = state.at('rf')
//   token_reserve = state.at('rr')

function extractReserves(puzzleRevealHex) {
  try {
    const puzzle = parseCLVM(puzzleRevealHex);

    const outer = uncurry(puzzle);
    if (!outer) return null;

    const innerPuzzle = outer.argList.at('rf');
    const inner = uncurry(innerPuzzle);
    if (!inner) return null;

    const state = inner.argList.at('rrf');
    if (!state || !state.isCons) return null;

    const xchReserve   = state.at('rf').toUInt();
    const tokenReserve = state.at('rr').toUInt();

    if (!xchReserve || !tokenReserve) return null;
    return { xchReserve, tokenReserve };
  } catch {
    return null;
  }
}

// ── Event classification (mirrors token-indexer.js) ──────────────────────────

function classifyEvent(oldXch, oldToken, newXch, newToken) {
  const dx = newXch   - oldXch;
  const dt = newToken - oldToken;
  if (dx === 0 && dt === 0) return null;
  if (dx > 0 && dt < 0) return { type: 'trade',     side: 'buy',  xchDelta: dx,  tokenDelta: -dt };
  if (dx < 0 && dt > 0) return { type: 'trade',     side: 'sell', xchDelta: -dx, tokenDelta: dt  };
  if (dx > 0 && dt > 0) return { type: 'lp_add',    side: null,   xchDelta: dx,  tokenDelta: dt  };
  if (dx < 0 && dt < 0) return { type: 'lp_remove', side: null,   xchDelta: -dx, tokenDelta: -dt };
  return null;
}

// ── Per-pair backfill ─────────────────────────────────────────────────────────

async function backfillPair(pair, cutoffTime) {
  const { launcher_id, asset_id, xch_reserve: currentXch, token_reserve: currentToken } = pair;
  // currentXch/currentToken used as fallback if Tibet API doesn't return reserves
  const short = asset_id.slice(0, 8);

  // Get head coin ID and current reserves from Tibet API (don't trust stale DB values)
  let headCoinId, curXch, curToken;
  try {
    const res = await fetch(`${TIBET_API}/pair/${launcher_id}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    headCoinId = hexNorm(data.last_coin_id_on_chain || '');
    curXch     = Number(data.xch_reserve   || currentXch  || 0);
    curToken   = Number(data.token_reserve || currentToken || 0);
  } catch (e) {
    console.warn(`  [${short}] Tibet API: ${e.message}`);
    return 0;
  }

  if (!headCoinId || headCoinId.length !== 64) {
    console.warn(`  [${short}] no valid last_coin_id_on_chain`);
    return 0;
  }

  if (!curXch || !curToken) {
    console.warn(`  [${short}] no reserves from Tibet API — skipping`);
    return 0;
  }

  let curCoinId = headCoinId;

  const events = [];
  let steps = 0;

  while (steps < MAX_STEPS) {
    steps++;

    // ── 1. Get coin record to find parent and creation height ──────────────
    let coinRecord;
    try {
      await sleep(RPC_DELAY_MS);
      const r = await nodeRpc('get_coin_record_by_name', { name: '0x' + curCoinId });
      coinRecord = r.coin_record;
    } catch (e) {
      console.warn(`  [${short}] getCoinRecord ${curCoinId.slice(0, 8)}: ${e.message}`);
      break;
    }
    if (!coinRecord) break;

    const parentId     = hexNorm(coinRecord.coin.parent_coin_info);
    const createdAt    = coinRecord.confirmed_block_index;

    if (!parentId || parentId.length !== 64) break;  // reached genesis

    // ── 2. Get block timestamp (creation of this coin = when swap occurred) ─
    let blockTime = null;
    try {
      await sleep(RPC_DELAY_MS);
      blockTime = await getBlockTimestamp(createdAt);
    } catch { /* non-fatal */ }

    if (cutoffTime && blockTime && blockTime < cutoffTime) break;

    // ── 3. Get puzzle_reveal of the parent coin (spent at createdAt) ────────
    let prevReserves = null;
    try {
      await sleep(RPC_DELAY_MS);
      const ps = await nodeRpc('get_puzzle_and_solution', {
        coin_id: '0x' + parentId,
        height:  createdAt,
      });
      if (ps?.coin_solution?.puzzle_reveal) {
        prevReserves = extractReserves(ps.coin_solution.puzzle_reveal);
      }
    } catch (e) {
      // Launcher/genesis parent will fail or return non-pair puzzle — expected
      if (!/not found|404|failed/i.test(e.message)) {
        console.warn(`  [${short}] getPuzzleAndSolution ${parentId.slice(0, 8)}: ${e.message}`);
      }
    }

    if (!prevReserves) break;  // reached genesis or non-pair coin

    const { xchReserve: prevXch, tokenReserve: prevToken } = prevReserves;

    // ── 4. Classify the event (prev → cur = what changed at createdAt) ──────
    const ev = classifyEvent(prevXch, prevToken, curXch, curToken);
    if (ev && ev.xchDelta > 0) {
      const volumeXch    = ev.xchDelta   / 1e12;
      const amountTokens = ev.tokenDelta / 1000;
      events.push({
        asset_id:       asset_id,
        offer_id:       `amm:${curCoinId}`,  // unique per singleton advance
        price_xch:      (ev.type === 'trade' && amountTokens > 0)
          ? volumeXch / amountTokens : null,
        amount_tokens:  amountTokens,
        volume_xch:     volumeXch,
        block_height:   createdAt,
        transferred_at: blockTime || new Date().toISOString(),
        source:         'onchain',
        event_type:     ev.type,
        side:           ev.side || null,
      });
    }

    // Walk backwards
    curCoinId = parentId;
    curXch    = prevXch;
    curToken  = prevToken;

    if (steps % 50 === 0) {
      process.stdout.write(`\r  [${short}] ${steps} steps · ${events.length} events · h=${createdAt}  `);
    }
  }

  if (steps > 1) process.stdout.write('\n');

  if (!events.length) return 0;

  // Insert in chronological order (oldest first)
  events.reverse();

  let inserted = 0;
  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const batch = events.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('cat_transfers')
      .upsert(batch, { onConflict: 'offer_id', ignoreDuplicates: true });

    if (!error) {
      inserted += batch.length;
    } else if (error.code === '23505' || /unique|duplicate/i.test(error.message || '')) {
      // Individual fallback
      for (const row of batch) {
        const { error: e2 } = await supabase.from('cat_transfers').insert(row);
        if (!e2) inserted++;
      }
    } else {
      console.error(`  [${short}] insert error: ${error.message}`);
    }
  }

  return inserted;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args    = process.argv.slice(2);
  const daysIdx = args.indexOf('--days');
  const days    = daysIdx !== -1 ? Number(args[daysIdx + 1]) : 30;
  const skip    = new Set(daysIdx !== -1 ? [daysIdx + 1] : []);
  const singleId = args.find((a, i) => !a.startsWith('--') && !skip.has(i)) || null;

  const cutoffTime = days > 0
    ? new Date(Date.now() - days * 86_400_000).toISOString()
    : null;

  console.log(`AMM history backfill`);
  console.log(`  cutoff : ${cutoffTime || 'full history'}`);
  if (singleId) console.log(`  asset  : ${singleId}`);

  let query = supabase
    .from('tibet_pairs')
    .select('launcher_id, asset_id, xch_reserve, token_reserve')
    .not('launcher_id', 'is', null);
  if (singleId) query = query.eq('asset_id', singleId);

  const { data: pairs, error } = await query;
  if (error) { console.error('DB error:', error.message); process.exit(1); }
  if (!pairs?.length) { console.log('No pairs found.'); process.exit(0); }

  // Sort by xch_reserve desc (largest pairs first — most impactful)
  pairs.sort((a, b) => Number(b.xch_reserve || 0) - Number(a.xch_reserve || 0));

  console.log(`Processing ${pairs.length} pair(s)…\n`);

  let totalInserted = 0;
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const xchBal = (Number(pair.xch_reserve || 0) / 1e12).toFixed(0);
    process.stdout.write(`[${i + 1}/${pairs.length}] ${pair.asset_id.slice(0, 8)} (${xchBal} XCH TVL)… `);
    const n = await backfillPair(pair, cutoffTime);
    console.log(`${n} events inserted`);
    totalInserted += n;
    await sleep(300);
  }

  console.log(`\nDone. Total: ${totalInserted} events inserted.`);
}

main().catch(e => { console.error(e); process.exit(1); });
