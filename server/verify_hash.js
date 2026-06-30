'use strict';
require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = 'e8bbba89-8835-4842-bf48-4bb18b17d873';
const TOKEN_INDEX = parseInt(process.argv[2] || '80');
const ON_CHAIN_HASH = process.argv[3] || '314c918c0c06db867fddf1d0fcedb4cb8c5afed6e8b5ca076eacf33c56d7b56a';

const SUPABASE_URL = process.env.SUPABASE_URL;

async function run() {
  // Local file hash
  const localPath = path.join(__dirname, 'output', PROJECT_ID, `${TOKEN_INDEX}.png`);
  const localBuf = fs.readFileSync(localPath);
  const localHash = crypto.createHash('sha256').update(localBuf).digest('hex');

  // Supabase download hash
  const url = `${SUPABASE_URL}/storage/v1/object/public/output/${PROJECT_ID}/${TOKEN_INDEX}.png`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const supabaseBuf = Buffer.from(await res.arrayBuffer());
  const supabaseHash = crypto.createHash('sha256').update(supabaseBuf).digest('hex');

  console.log(`Token #${TOKEN_INDEX}`);
  console.log(`On-chain hash : ${ON_CHAIN_HASH}`);
  console.log(`Local file    : ${localHash}  ${localHash === ON_CHAIN_HASH ? '✓ MATCH' : '✗ MISMATCH'}`);
  console.log(`Supabase      : ${supabaseHash}  ${supabaseHash === ON_CHAIN_HASH ? '✓ MATCH' : '✗ MISMATCH'}`);
  console.log(`Local=Supabase: ${localHash === supabaseHash ? 'yes' : 'NO — files differ'}`);
  console.log(`Local size: ${localBuf.length} bytes  Supabase size: ${supabaseBuf.length} bytes`);
}

run().catch(console.error);
