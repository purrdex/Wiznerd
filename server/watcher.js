'use strict';

const PROXY = process.env.PROXY_URL || 'http://localhost:3001';

function addressToPuzzleHash(address) {
  try {
    const { bech32m } = require('bech32');
    const decoded = bech32m.decode(address);
    const bytes = bech32m.fromWords(decoded.words);
    return Buffer.from(bytes).toString('hex');
  } catch { return null; }
}

async function nodeRpc(endpoint, body) {
  const res = await fetch(`${PROXY}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`node ${res.status}`);
  return res.json();
}

async function checkPendingOrders(supabase) {
  const { data: orders } = await supabase
    .from('orders')
    .select('id, payment_address, payment_amount_mojo, project_id, buyer_address')
    .eq('status', 'pending_payment');

  if (!orders || orders.length === 0) return;

  for (const order of orders) {
    try {
      const puzzleHash = addressToPuzzleHash(order.payment_address);
      if (!puzzleHash) continue;

      const data = await nodeRpc('get_coin_records_by_puzzle_hash', {
        puzzle_hash: puzzleHash,
        include_spent_coins: true,
      });

      const coins = data.coin_records || [];
      const paid = coins.find(c => BigInt(c.coin.amount) >= BigInt(order.payment_amount_mojo));

      if (paid) {
        await supabase.from('orders').update({
          status: 'payment_detected',
          tx_id: paid.coin.parent_coin_info,
        }).eq('id', order.id);

        dispatchMint(order.id, supabase);
      }
    } catch {
      // Node unavailable — skip silently, will retry next tick
    }
  }
}

let mintQueue = null;

function setMintQueue(q) { mintQueue = q; }

async function dispatchMint(orderId, supabase) {
  if (mintQueue) {
    mintQueue.add('mint', { orderId }).catch(() => {
      const { mint } = require('./mint');
      mint(orderId, supabase).catch(e => console.warn('[watcher] mint fallback error:', e.message));
    });
  } else {
    const { mint } = require('./mint');
    mint(orderId, supabase).catch(e => console.warn('[watcher] mint error:', e.message));
  }
}

let watcherTimer = null;

function startWatcher(supabase) {
  if (watcherTimer) return;
  watcherTimer = setInterval(
    () => checkPendingOrders(supabase).catch(() => {}),
    10000,
  );
  console.log('[watcher] payment watcher started — polling every 10s');
}

function stopWatcher() {
  if (watcherTimer) { clearInterval(watcherTimer); watcherTimer = null; }
}

module.exports = { startWatcher, stopWatcher, setMintQueue };
