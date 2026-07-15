'use strict';
// Token Launcher — mints a new CAT, registers with SpaceScan, deploys TibetSwap pair.
// Called from marketplace.js after XCH payment is confirmed at the unique payment address.

const TIBET_API  = 'https://api.v2.tibetswap.io';
const SPACESCAN  = 'https://api.spacescan.io/cat/info/updatecat';
const WIZNERD_FEE_MOJO  =   537_000_000_000n;          // 0.537 XCH
const TIBET_FEE_MOJO    =   462_000_000_001n;          // 0.462 XCH + 1 mojo singleton
const MINT_TX_FEE_MOJO  =     1_000_000_000n;          // 0.001 XCH blockchain fee

// Total fee charged to user (not counting pool liquidity)
const TOTAL_FEE_MOJO = WIZNERD_FEE_MOJO + TIBET_FEE_MOJO + MINT_TX_FEE_MOJO;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function tibetPost(path, body) {
  const r = await fetch(`${TIBET_API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const json = await r.json();
  if (!r.ok) throw new Error(`Tibet ${path}: ${json.message || r.status}`);
  return json;
}

// ── Status helpers ────────────────────────────────────────────────────────────

async function setStatus(supabase, id, status, extra = {}) {
  await supabase.from('launched_tokens')
    .update({ status, updated_at: new Date().toISOString(), ...extra })
    .eq('id', id);
}

// ── Payment detection ─────────────────────────────────────────────────────────
// Polls the node for an unspent coin at the payment address with the exact amount.

async function waitForPayment(proxy, puzzleHash, expectedMojo, timeoutMs = 30 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${proxy}/get_coin_records_by_puzzle_hashes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ puzzle_hashes: [`0x${puzzleHash}`], include_spent_coins: false }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await r.json();
      const coins = (data.coin_records || []).filter(c => !c.spent);
      const total = coins.reduce((s, c) => s + BigInt(c.coin.amount), 0n);
      if (total >= BigInt(expectedMojo)) return true;
    } catch { /* retry */ }
    await sleep(15000);
  }
  return false;
}

// ── Find our newly-created pair by asset_id ───────────────────────────────────
// Polls Tibet /pairs (newest first) until the pair appears, up to ~5 minutes.

async function findPairLauncherId(assetId, timeoutMs = 5 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // New pairs appear at low skip values; 100 should cover any recent burst
      const r = await fetch(`${TIBET_API}/pairs?skip=0&limit=100`, {
        signal: AbortSignal.timeout(10000),
      });
      const pairs = await r.json();
      const match = Array.isArray(pairs) && pairs.find(p => p.asset_id === assetId);
      if (match) return match.pair_id || match.launcher_id;
    } catch { /* retry */ }
    await sleep(15000);
  }
  return null;
}

// ── Core launch flow ──────────────────────────────────────────────────────────

async function executeLaunch(supabase, proxy, walletRpc, launchId) {
  const { data: launch, error } = await supabase
    .from('launched_tokens').select('*').eq('id', launchId).single();
  if (error || !launch) throw new Error('Launch record not found');

  try {
    // ── 1. Mint the CAT ───────────────────────────────────────────────────────
    await setStatus(supabase, launchId, 'minting');

    const mintRes = await walletRpc('create_new_wallet', {
      wallet_type: 'cat_wallet',
      mode: 'new',
      amount: launch.total_supply,
      fee: Number(MINT_TX_FEE_MOJO),
    });
    if (!mintRes.success) throw new Error(`Mint failed: ${mintRes.error}`);

    const assetId    = mintRes.asset_id;
    const catWalletId = mintRes.wallet_id;

    await setStatus(supabase, launchId, 'minted', { asset_id: assetId });

    // Wait for mint tx to land (wallet needs it confirmed before making offer)
    await sleep(60000);

    // ── 2. Register with SpaceScan ────────────────────────────────────────────
    try {
      // Get server's primary address for signing
      const addrRes = await walletRpc('get_next_address', { wallet_id: 1, new_address: false });
      const signerAddress = addrRes.address;

      const signRes = await walletRpc('sign_message_by_address', {
        address: signerAddress,
        message: 'Confirm Sign in to import Tokens from spacescan.io',
      });

      await fetch(SPACESCAN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pubkey:       signRes.pubkey,
          signature:    signRes.signature,
          signing_mode: signRes.signing_mode,
          message:      'Confirm Sign in to import Tokens from spacescan.io',
          address:      signerAddress,
          asset_id:     assetId,
          asset_name:   launch.name,
          cat_symbol:   launch.symbol,
          description:  launch.description || '',
          image_url:    launch.image_url || '',
          multiplier:   '1000',
        }),
        signal: AbortSignal.timeout(15000),
      });

      await supabase.from('launched_tokens')
        .update({ spacescan_submitted: true }).eq('id', launchId);
    } catch (e) {
      console.warn(`[launcher] SpaceScan submission failed for ${launchId}: ${e.message}`);
      // Non-fatal — pair deployment continues
    }

    // ── 3. Create TibetSwap pair ──────────────────────────────────────────────
    await setStatus(supabase, launchId, 'deploying');

    const xchMojo = BigInt(launch.xch_liquidity);
    const catMojo = BigInt(launch.cat_liquidity);
    // Offer total XCH = liquidity + Tibet fees + LP minting fee (cat_mojos as tiny XCH)
    const tibetFees = 462_000_000_001n;
    const lpMintFee = catMojo; // cat mojos / 1e12 ≈ negligible but required
    const totalXchOffer = xchMojo + tibetFees + lpMintFee;

    const offerRes = await walletRpc('create_offer_for_ids', {
      offer: {
        1: -Number(totalXchOffer),       // XCH wallet (negative = offering)
        [catWalletId]: -Number(catMojo), // CAT wallet (negative = offering)
      },
      fee: 0,
      validate_only: false,
    });
    if (!offerRes.success) throw new Error(`Offer creation failed: ${offerRes.error}`);

    const offerStr = offerRes.offer;

    const tibetRes = await tibetPost(`/new-pair/${assetId}`, {
      offer:                        offerStr,
      xch_liquidity:                Number(xchMojo),
      token_liquidity:              Number(catMojo),
      hidden_puzzle_hash:           null,
      inverse_fee:                  993,
      liquidity_destination_address: launch.creator_address,
    });

    if (!tibetRes.success) throw new Error(`Tibet pair creation failed: ${tibetRes.message}`);

    await setStatus(supabase, launchId, 'live', { pair_coin_id: tibetRes.coin_id });

    // ── 4. Dev buy (optional) ─────────────────────────────────────────────────
    if (launch.dev_buy_mojo && BigInt(launch.dev_buy_mojo) > 0n) {
      try {
        const launcherId = await findPairLauncherId(assetId);
        if (!launcherId) throw new Error('pair not found in Tibet API');

        await supabase.from('launched_tokens')
          .update({ pair_launcher_id: launcherId }).eq('id', launchId);

        const quoteR = await fetch(
          `${TIBET_API}/quote/${launcherId}?amount_in=${launch.dev_buy_mojo}&xch_is_input=true`,
          { signal: AbortSignal.timeout(10000) }
        );
        const quote = await quoteR.json();
        const minCatOut = Math.floor(Number(quote.amount_out) * 0.98); // 2% slippage

        const swapOfferRes = await walletRpc('create_offer_for_ids', {
          offer: {
            1: -Number(launch.dev_buy_mojo),
            [catWalletId]: minCatOut,
          },
          fee: 0,
          validate_only: false,
        });
        if (!swapOfferRes.success) throw new Error(swapOfferRes.error);

        const swapRes = await tibetPost(`/offer/${launcherId}`, {
          offer:  swapOfferRes.offer,
          action: 'SWAP',
        });
        if (!swapRes.success) throw new Error(swapRes.message);

        await supabase.from('launched_tokens')
          .update({ dev_buy_cat_mojo: minCatOut }).eq('id', launchId);
      } catch (e) {
        console.warn(`[launcher] dev buy failed for ${launchId}: ${e.message}`);
      }
    }

    return { asset_id: assetId, coin_id: tibetRes.coin_id };

  } catch (e) {
    await setStatus(supabase, launchId, 'failed', { error_message: e.message });
    throw e;
  }
}

module.exports = { executeLaunch, waitForPayment, TOTAL_FEE_MOJO };
