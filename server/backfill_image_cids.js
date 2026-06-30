'use strict';
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PROJECT_ID   = 'e8bbba89-8835-4842-bf48-4bb18b17d873';

const headers = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

async function getTokens() {
  const url = `${SUPABASE_URL}/rest/v1/generated_tokens?project_id=eq.${PROJECT_ID}&metadata_uri=not.is.null&image_cid=is.null&select=id,token_index,metadata_uri`;
  const res = await fetch(url, { headers });
  return res.json();
}

async function updateImageCid(id, imageCid) {
  const url = `${SUPABASE_URL}/rest/v1/generated_tokens?id=eq.${id}`;
  await fetch(url, { method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' }, body: JSON.stringify({ image_cid: imageCid }) });
}

async function run() {
  const tokens = await getTokens();
  console.log(`Backfilling ${tokens.length} tokens...`);

  for (const token of tokens) {
    const gateways = [
      'https://ipfs.io/ipfs/',
      'https://cloudflare-ipfs.com/ipfs/',
      'https://nftstorage.link/ipfs/',
      'https://dweb.link/ipfs/',
    ];
    const cid = token.metadata_uri.replace('ipfs://', '');
    let done = false;
    for (const gw of gateways) {
      try {
        const res = await fetch(`${gw}${cid}`, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) continue;
        const meta = await res.json();
        const imageCid = (meta.image || '').replace('ipfs://', '');
        if (!imageCid) { console.log(`#${token.token_index}: no image CID in JSON`); break; }
        await updateImageCid(token.id, imageCid);
        console.log(`#${token.token_index}: ${imageCid} (via ${gw})`);
        done = true;
        break;
      } catch (e) {
        console.log(`#${token.token_index}: ${gw} failed — ${e.message}`);
      }
    }
    if (!done) console.log(`#${token.token_index}: all gateways failed`);
  }
  console.log('Done.');
}

run();
