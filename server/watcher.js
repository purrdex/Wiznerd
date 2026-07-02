'use strict';

const PROXY = process.env.PROXY_URL || 'http://localhost:3001';

const skippedCoins = new Set(); // suppress repeated logs for below-price coins

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

function puzzleHashToAddress(puzzleHash) {
  const { bech32m } = require('bech32');
  const hex = puzzleHash.replace(/^0x/, '');
  return bech32m.encode('xch', bech32m.toWords(Buffer.from(hex, 'hex')));
}

async function getSenderAddress(paymentParentCoinInfo, paymentPuzzleHash) {
  try {
    const parentId = paymentParentCoinInfo.startsWith('0x')
      ? paymentParentCoinInfo : '0x' + paymentParentCoinInfo;

    // Find all coins created by the same spend (payment coin + change coins)
    const data = await nodeRpc('get_coin_records_by_parent_ids', {
      parent_ids: [parentId],
      include_spent_coins: true,
    });

    const siblings = data.coin_records || [];
    console.log(`[watcher] getSenderAddress: ${siblings.length} sibling coins from spend`);

    const paymentPH = (paymentPuzzleHash || '').replace(/^0x/, '').toLowerCase();

    // Multiple siblings possible (payment + change + 1-mojo hint coins).
    // The CHANGE coin is the one with the largest amount — not the hint/fee coins.
    const nonPaymentSiblings = siblings.filter(r => {
      const ph = (r.coin.puzzle_hash || '').replace(/^0x/, '').toLowerCase();
      return ph !== paymentPH;
    });
    nonPaymentSiblings.sort((a, b) => {
      const diff = BigInt(b.coin.amount) - BigInt(a.coin.amount);
      return diff > 0n ? 1 : diff < 0n ? -1 : 0;
    });
    const changeCoin = nonPaymentSiblings[0] || null;
    console.log(`[watcher] sibling amounts: ${siblings.map(r => r.coin.amount).join(', ')}`);

    if (changeCoin) {
      const addr = puzzleHashToAddress(changeCoin.coin.puzzle_hash);
      console.log(`[watcher] detected sender (change coin): ${addr}`);
      return addr;
    }

    // No change coin — sender paid exact amount. Fall back to parent coin's puzzle hash.
    console.log('[watcher] no change coin found — falling back to parent coin puzzle hash');
    const parentData = await nodeRpc('get_coin_record_by_name', { name: parentId });
    const ph = parentData.coin_record?.coin?.puzzle_hash;
    if (!ph) return null;
    const addr = puzzleHashToAddress(ph);
    console.log(`[watcher] detected sender (parent coin): ${addr}`);
    return addr;
  } catch (e) {
    console.log(`[watcher] getSenderAddress error: ${e.message}`);
    return null;
  }
}

async function checkProjects(supabase) {
  // Watch each live collection's payment address for new incoming coins
  const { data: projects } = await supabase
    .from('projects')
    .select('id, payment_address, mint_price_mojo, total_supply, updated_at')
    .eq('marketplace_status', 'live')
    .not('payment_address', 'is', null);

  for (const project of projects || []) {
    try {
      const puzzleHash = addressToPuzzleHash(project.payment_address);
      if (!puzzleHash) continue;

      const data = await nodeRpc('get_coin_records_by_puzzle_hash', {
        puzzle_hash: '0x' + puzzleHash,
        include_spent_coins: true,
      });

      const coins = data.coin_records || [];
      const pricePerNft = BigInt(project.mint_price_mojo || 0);
      // Only count coins that arrived after the payment address was set (project published)
      const publishedAt = project.updated_at ? Math.floor(new Date(project.updated_at).getTime() / 1000) : 0;

      for (const coinRecord of coins) {
        if (publishedAt && (coinRecord.timestamp || 0) < publishedAt) continue;
        const txId = (coinRecord.coin.parent_coin_info || '').replace(/^0x/, '');

        // Skip if this payment was already processed
        const { data: existing } = await supabase
          .from('orders')
          .select('id')
          .eq('project_id', project.id)
          .eq('tx_id', txId)
          .maybeSingle();
        if (existing) continue;

        const received = BigInt(coinRecord.coin.amount);
        if (received === 0n) continue;
        if (pricePerNft > 0n && received < pricePerNft) {
          if (!skippedCoins.has(txId)) {
            skippedCoins.add(txId);
            console.log(`[watcher] skipping coin ${txId.slice(0, 8)}… — amount ${received} below mint price ${pricePerNft}`);
          }
          continue;
        }

        const quantity = pricePerNft > 0n
          ? Math.max(1, Number(received / pricePerNft))
          : 1;

        const senderAddress = await getSenderAddress(txId, coinRecord.coin.puzzle_hash);

        const { data: order, error } = await supabase.from('orders').insert({
          project_id: project.id,
          payment_address: project.payment_address,
          payment_amount_mojo: project.mint_price_mojo,
          buyer_address: senderAddress || null,
          quantity,
          minted_count: 0,
          status: 'payment_detected',
          tx_id: txId,
        }).select().single();

        if (error) { console.warn(`[watcher] order insert error: ${error.message}`); continue; }
        console.log(`[watcher] new payment: ${quantity} NFT(s) → ${senderAddress || 'unknown (fallback to creator)'}`);
        dispatchMint(order.id, supabase);
      }
    } catch (e) {
      // Node unavailable — skip silently
    }
  }

  // Retry failed/partial orders — max 5 attempts before giving up
  const MAX_RETRIES = 5;

  const { data: failedOrders } = await supabase
    .from('orders')
    .select('id, status, minted_count, quantity, retry_count')
    .in('status', ['payment_detected', 'failed'])
    .lt('retry_count', MAX_RETRIES);

  const { data: confirmedOrders } = await supabase
    .from('orders')
    .select('id, status, minted_count, quantity, retry_count')
    .eq('status', 'confirmed')
    .gt('quantity', 1)
    .lt('retry_count', MAX_RETRIES);

  const retryOrders = [
    ...(failedOrders || []),
    ...(confirmedOrders || []).filter(o => (o.minted_count || 0) < (o.quantity || 1)),
  ];

  for (const order of retryOrders) {
    const attempts = (order.retry_count || 0) + 1;
    console.log(`[watcher] retrying order ${order.id} (${order.status}, ${order.minted_count || 0}/${order.quantity || 1}, attempt ${attempts}/${MAX_RETRIES})`);
    await supabase.from('orders').update({ retry_count: attempts }).eq('id', order.id);
    if (order.status === 'confirmed') {
      await supabase.from('orders').update({ status: 'failed' }).eq('id', order.id);
    }
    dispatchMint(order.id, supabase);
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
    () => checkProjects(supabase).catch(() => {}),
    10000,
  );
  console.log('[watcher] payment watcher started — polling every 10s');
}

function stopWatcher() {
  if (watcherTimer) { clearInterval(watcherTimer); watcherTimer = null; }
}

module.exports = { startWatcher, stopWatcher, setMintQueue };
