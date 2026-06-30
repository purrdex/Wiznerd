'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PROJECT_ID   = 'e8bbba89-8835-4842-bf48-4bb18b17d873';
const OUTPUT_DIR   = path.join(__dirname, 'output', PROJECT_ID);

const headers = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
};

async function uploadImage(tokenIndex, buf) {
  const storagePath = `${PROJECT_ID}/${tokenIndex}.png`;
  const url = `${SUPABASE_URL}/storage/v1/object/output/${storagePath}`;

  // Try PATCH (update) first, fall back to POST (create)
  let res = await fetch(url, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'image/png', 'x-upsert': 'true' },
    body: buf,
    signal: AbortSignal.timeout(30000),
  });
  return res.ok ? 'ok' : `${res.status} ${await res.text().then(t => t.slice(0, 80))}`;
}

async function run() {
  const files = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.png'));
  console.log(`Found ${files.length} PNG files in ${OUTPUT_DIR}`);

  for (const file of files.sort()) {
    const tokenIndex = parseInt(file);
    if (isNaN(tokenIndex)) continue;
    const buf = fs.readFileSync(path.join(OUTPUT_DIR, file));
    const result = await uploadImage(tokenIndex, buf);
    console.log(`${file}: ${result}`);
  }
  console.log('Done. Supabase storage now matches local files.');
}

run().catch(console.error);
