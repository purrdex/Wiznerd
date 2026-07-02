'use strict';

const crypto = require('crypto');
const PROXY = process.env.PROXY_URL || 'http://localhost:3001';

let nftWalletIdCache = null;

async function getNFTWalletId() {
  if (nftWalletIdCache) return nftWalletIdCache;
  if (process.env.MINTER_NFT_WALLET_ID) {
    nftWalletIdCache = parseInt(process.env.MINTER_NFT_WALLET_ID);
    return nftWalletIdCache;
  }
  const res = await fetch(`${PROXY}/wallet/get_wallets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 10 }), // 10 = NFTWallet
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`get_wallets HTTP ${res.status}`);
  const j = await res.json();
  const nftWallet = (j.wallets || []).find(w => w.type === 10);
  if (!nftWallet) throw new Error('No NFT wallet found — create one in the Chia GUI (Wallets → + → NFT Wallet)');
  nftWalletIdCache = nftWallet.id;
  return nftWalletIdCache;
}

async function sha256Storage(supabase, imagePath) {
  const { data, error } = await supabase.storage.from('output').download(imagePath);
  if (error) throw new Error(`Storage download failed: ${error.message}`);
  const buf = Buffer.from(await data.arrayBuffer());
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function mintNFT(token, project, recipientAddress, supabase) {
  const supabaseUrl = process.env.SUPABASE_URL || '';

  // Recover image_cid if missing — read from local metadata JSON on disk (no network needed)
  if (!token.image_cid) {
    const metaPath = require('path').join(__dirname, 'output', token.project_id, `${token.token_index}.json`);
    if (require('fs').existsSync(metaPath)) {
      try {
        const meta = JSON.parse(require('fs').readFileSync(metaPath, 'utf8'));
        const cid = (meta.image || '').replace('ipfs://', '');
        if (cid) {
          await supabase.from('generated_tokens').update({ image_cid: cid }).eq('id', token.id);
          token.image_cid = cid;
          console.log(`[mint] recovered image_cid from local JSON: ${cid}`);
        }
      } catch {}
    }
  }

  // image_cid is either "{dirCid}/{index}.png" (directory upload) or a bare CID (legacy).
  // Use HTTPS gateway as uris[0] — that's what wallets and explorers actually resolve.
  const imageCid = token.image_cid || '';
  const imageUris = [
    imageCid ? `https://gateway.pinata.cloud/ipfs/${imageCid}` : '',
    imageCid ? `ipfs://${imageCid}` : '',
    token.image_path ? `${supabaseUrl}/storage/v1/object/public/output/${token.image_path}` : '',
  ].filter(Boolean);
  if (!imageUris.length) throw new Error(`Token ${token.token_index} has no image URL`);

  // Hash must match the IPFS bytes exactly (IPFS was uploaded from the local file)
  // Priority: local disk file → Supabase storage → zeros fallback
  let dataHash = token.data_hash || '';
  if (!dataHash) {
    const localPath = require('path').join(__dirname, 'output', token.project_id, `${token.token_index}.png`);
    if (require('fs').existsSync(localPath)) {
      const buf = require('fs').readFileSync(localPath);
      dataHash = crypto.createHash('sha256').update(buf).digest('hex');
      console.log(`[mint] hash from local file: ${dataHash}`);
    } else if (token.image_path) {
      dataHash = await sha256Storage(supabase, token.image_path);
      console.log(`[mint] hash from Supabase (local file missing): ${dataHash}`);
    }
    if (dataHash) await supabase.from('generated_tokens').update({ data_hash: dataHash }).eq('id', token.id);
  }
  if (!dataHash) dataHash = '0'.repeat(64);

  const walletId = await getNFTWalletId();

  const serverUrl = process.env.SERVER_URL || 'http://localhost:3002';
  // metadata_uri is "ipfs://{dirCid}/{index}.json" or "ipfs://{bareCid}"
  const metaCidPath = (token.metadata_uri || '').replace('ipfs://', '');
  const metaUris = metaCidPath ? [
    `https://gateway.pinata.cloud/ipfs/${metaCidPath}`,
    `ipfs://${metaCidPath}`,
  ] : [`${serverUrl}/api/nft/${token.project_id}/${token.token_index}/metadata.json`];

  const body = {
    wallet_id: walletId,
    uris: imageUris,
    hash: dataHash,
    meta_uris: metaUris,
    meta_hash: token.meta_hash || undefined,
    series_number: token.token_index + 1,
    series_total: project.total_supply,
    did_id: process.env.MINTER_DID || undefined,
    target_address: recipientAddress || project.creator_address || '',
    royalty_address: project.creator_address || '',
    royalty_percentage: Math.round((project.royalty_percent || 0) * 100),
    fee: 0,
  };

  console.log('[mint] nft_mint_nft request:', JSON.stringify({ uris: body.uris, hash: body.hash, meta_uris: body.meta_uris, meta_hash: body.meta_hash, series_number: body.series_number, series_total: body.series_total, target_address: body.target_address }));

  const res = await fetch(`${PROXY}/wallet/nft_mint_nft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`nft_mint_nft HTTP ${res.status}: ${text.slice(0, 200)}`);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`nft_mint_nft bad JSON: ${text.slice(0, 200)}`); }
  if (!json.success) throw new Error(`nft_mint_nft: ${json.error || JSON.stringify(json).slice(0, 200)}`);

  const nftId = json.nft_id ||
    json.spend_bundle?.coin_spends?.[0]?.coin?.parent_coin_info ||
    json.tx_id ||
    '';

  console.log('[mint] nft_mint_nft response:', JSON.stringify({
    nft_id: nftId,
    tx_id: json.tx_id,
    target_address: body.target_address,
  }, null, 2));

  // Trigger MintGarden indexer — Sage uses MintGarden's index for its NFT section
  if (nftId) {
    fetch(`https://api.mintgarden.io/nfts/${nftId}`, { signal: AbortSignal.timeout(15000) })
      .catch(() => {});
    fetch(`https://api2.spacescan.io/nft/info/${nftId}`, { signal: AbortSignal.timeout(15000) })
      .catch(() => {});
  }

  return nftId;
}

async function waitForSpendable(maxWaitMs = 300000) {
  const start = Date.now();
  let logged = false;
  while (Date.now() - start < maxWaitMs) {
    try {
      // XCH for minting comes from the standard wallet (id=1), not the NFT wallet
      const res = await fetch(`${PROXY}/wallet/get_wallet_balance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet_id: 1 }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const j = await res.json();
        const spendable = BigInt(j.wallet_balance?.spendable_balance ?? 0);
        if (spendable > 0n) {
          if (logged) console.log(`[mint] spendable balance recovered (${spendable} mojo)`);
          return;
        }
        console.log(`[mint] waiting for spendable balance… (${Math.round((Date.now() - start) / 1000)}s elapsed)`);
        logged = true;
      }
    } catch (e) {
      console.log(`[mint] waitForSpendable check failed: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 15000));
  }
  throw new Error('Timed out waiting for spendable balance — fund your standard XCH wallet');
}

async function mintOne(order, project, supabase) {
  const { data: token } = await supabase
    .from('generated_tokens')
    .select('*')
    .eq('project_id', order.project_id)
    .eq('status', 'pinned')
    .not('metadata_uri', 'is', null)
    .is('buyer_address', null)
    .order('token_index')
    .limit(1)
    .single();

  if (!token) throw new Error('No available tokens to mint');

  const { error: reserveErr } = await supabase
    .from('generated_tokens')
    .update({ buyer_address: '__reserved__' })
    .eq('id', token.id)
    .is('buyer_address', null);

  if (reserveErr) throw new Error('Token reservation conflict — will retry');

  const recipient = order.buyer_address || project.creator_address;
  const txId = await mintNFT(token, project, recipient, supabase);

  await supabase.from('generated_tokens')
    .update({ buyer_address: recipient })
    .eq('id', token.id);

  return { tokenId: token.id, txId };
}

async function mint(orderId, supabase) {
  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .select('*, projects(*)')
    .eq('id', orderId)
    .single();

  if (orderErr || !order) throw new Error(`Order ${orderId} not found`);
  if (!['payment_detected', 'failed'].includes(order.status)) return;

  const project = order.projects;
  if (project.mints_paused) throw new Error('Minting is paused for this collection');

  const quantity = order.quantity || 1;
  const alreadyMinted = order.minted_count || 0;
  const remaining = quantity - alreadyMinted;
  if (remaining <= 0) return;

  await supabase.from('orders').update({ status: 'minting' }).eq('id', orderId);

  const tokenIds = Array.isArray(order.token_ids) ? [...order.token_ids] : [];
  let mintedCount = alreadyMinted;

  for (let i = 0; i < remaining; i++) {
    try {
      // Always wait for spendable before each mint — handles retries where wallet is still drained
      await waitForSpendable();

      const { tokenId, txId } = await mintOne(order, project, supabase);
      tokenIds.push(tokenId);
      mintedCount++;

      await supabase.from('orders').update({
        minted_count: mintedCount,
        token_id: tokenIds[0],
        token_ids: tokenIds,
      }).eq('id', orderId);

      console.log(`[mint] order ${orderId}: minted ${mintedCount}/${quantity}`);

    } catch (e) {
      // Release any reserved token on failure
      await supabase.from('generated_tokens')
        .update({ buyer_address: null })
        .eq('buyer_address', '__reserved__')
        .eq('project_id', order.project_id);

      // Stay in failed so the watcher retries from minted_count
      await supabase.from('orders').update({
        status: 'failed',
        minted_count: mintedCount,
        error_message: e.message.slice(0, 500),
      }).eq('id', orderId);
      throw e;
    }
  }

  if (mintedCount < quantity) {
    await supabase.from('orders').update({
      status: 'failed',
      minted_count: mintedCount,
      error_message: `Partial: ${mintedCount}/${quantity} — loop exited early`,
    }).eq('id', orderId);
    return;
  }

  await supabase.from('orders').update({
    status: 'confirmed',
    minted_count: mintedCount,
    confirmed_at: new Date().toISOString(),
  }).eq('id', orderId);

  // Check sold out
  const { count: totalMinted } = await supabase
    .from('orders')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', order.project_id)
    .eq('status', 'confirmed');

  if ((totalMinted || 0) >= project.total_supply) {
    await supabase.from('projects')
      .update({ marketplace_status: 'sold_out' })
      .eq('id', order.project_id);
  }
}

module.exports = { mint };
