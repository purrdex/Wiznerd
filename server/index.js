'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

// ─── Supabase client (exported for use by generation.js / ipfs.js) ────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { realtime: { transport: ws } }
);
module.exports.supabase = supabase;

// ─── BullMQ (optional — probe Redis version before touching BullMQ) ──────────
let generationQueue = null;

(async () => {
  try {
    const IORedis = require('ioredis');
    const probe = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 1, connectTimeout: 3000,
    });
    probe.on('error', () => {});
    const info = await probe.info('server').catch(() => null);
    await probe.quit().catch(() => {});
    if (!info) return console.log('[server] Redis unavailable — generation will run synchronously');
    const m = info.match(/redis_version:(\d+)/);
    if (!m || parseInt(m[1]) < 5) {
      return console.log(`[server] Redis ${m ? m[1] : '?'}.x < 5 — BullMQ skipped, generation will run synchronously`);
    }
    const { Queue, Worker } = require('bullmq');
    const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: null });
    connection.on('error', () => {});
    generationQueue = new Queue('generation', { connection });
    generationQueue.on('error', () => { generationQueue = null; });
    const { generateFull } = require('./generation');
    new Worker('generation', async job => { await generateFull(job.data.projectId); }, { connection })
      .on('error', err => console.warn('[server] BullMQ generation worker error:', err.message));

    // Mint worker
    const mintQueue = new Queue('mint', { connection });
    const { setMintQueue } = require('./watcher');
    setMintQueue(mintQueue);
    const { mint } = require('./mint');
    new Worker('mint', async job => { await mint(job.data.orderId, supabase); }, { connection })
      .on('error', err => console.warn('[server] BullMQ mint worker error:', err.message));

    console.log('[server] BullMQ ready');
  } catch (e) {
    console.log('[server] BullMQ init error — generation will run synchronously:', e.message);
  }
})();

// ─── App ──────────────────────────────────────────────────────────────────────
const app = express();

const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:4173',
  process.env.FRONTEND_ORIGIN,
].filter(Boolean);

app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Serve generated images statically
const OUTPUT_DIR = path.join(__dirname, 'output');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
app.use('/output', express.static(OUTPUT_DIR));

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/thumb?path=<storagePath> — proxy a private layer image to the browser
app.get('/api/thumb', async (req, res) => {
  const storagePath = req.query.path;
  if (!storagePath) return res.status(400).end();
  const { data, error } = await supabase.storage.from('layers').download(storagePath);
  if (error || !data) return res.status(404).end();
  const buffer = Buffer.from(await data.arrayBuffer());
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(buffer);
});

// GET /api/projects — list by creator_address
app.get('/api/projects', async (req, res) => {
  const { creator_address } = req.query;
  if (!creator_address) return res.json([]);
  const { data, error } = await supabase.from('projects').select('*')
    .eq('creator_address', creator_address)
    .order('created_at', { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

// POST /api/projects — create project
app.post('/api/projects', async (req, res) => {
  const { name, symbol, total_supply, royalty_percent, creator_address, current_step } = req.body;
  if (!name || !symbol || !total_supply) return res.status(400).json({ error: 'name, symbol, total_supply required' });
  const { data, error } = await supabase
    .from('projects')
    .insert({
      name, symbol,
      total_supply: Number(total_supply),
      royalty_percent: Number(royalty_percent) || 0,
      creator_address: creator_address || null,
      current_step: Number(current_step) || 1,
    })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// GET /api/projects/:id — get project
app.get('/api/projects/:id', async (req, res) => {
  const { data, error } = await supabase.from('projects').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: error.message });
  res.json(data);
});

// PATCH /api/projects/:id — update step, status, or other fields
app.patch('/api/projects/:id', async (req, res) => {
  const updates = {};
  if (req.body.current_step !== undefined) updates.current_step = Number(req.body.current_step);
  if (req.body.status !== undefined) updates.status = req.body.status;
  updates.updated_at = new Date().toISOString();
  const { data, error } = await supabase.from('projects').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// DELETE /api/projects/:id — delete project and all storage files
app.delete('/api/projects/:id', async (req, res) => {
  const { id } = req.params;
  const { data: layers } = await supabase.from('layers').select('id').eq('project_id', id);
  if (layers && layers.length) {
    const { data: variants } = await supabase.from('variants')
      .select('file_path').in('layer_id', layers.map(l => l.id));
    const filePaths = (variants || []).map(v => v.file_path).filter(Boolean);
    if (filePaths.length) await supabase.storage.from('layers').remove(filePaths);
  }
  const { data: tokens } = await supabase.from('generated_tokens').select('image_path').eq('project_id', id);
  const outPaths = (tokens || []).map(t => t.image_path).filter(Boolean);
  if (outPaths.length) await supabase.storage.from('output').remove(outPaths);
  const { error } = await supabase.from('projects').delete().eq('id', id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

// POST /api/projects/:id/layers — upload layer + variant images
app.post('/api/projects/:id/layers', upload.array('files'), async (req, res) => {
  const { id } = req.params;
  const { layer_name, z_index } = req.body;
  if (!layer_name) return res.status(400).json({ error: 'layer_name required' });

  const { data: layer, error: layerErr } = await supabase
    .from('layers')
    .insert({ project_id: id, name: layer_name, z_index: Number(z_index) || 0 })
    .select()
    .single();
  if (layerErr) return res.status(400).json({ error: layerErr.message });

  const variants = [];
  const storageErrors = [];
  for (const file of req.files || []) {
    const filePath = `${id}/${layer.id}/${file.originalname}`;
    const { error: uploadErr } = await supabase.storage
      .from('layers')
      .upload(filePath, file.buffer, { contentType: file.mimetype, upsert: true });
    if (uploadErr) {
      console.warn('[upload]', uploadErr.message);
      storageErrors.push(`${file.originalname}: ${uploadErr.message}`);
      continue;
    }
    const variantName = path.parse(file.originalname).name;
    const { data: variant } = await supabase
      .from('variants')
      .insert({ layer_id: layer.id, name: variantName, file_path: filePath })
      .select()
      .single();
    if (variant) variants.push(variant);
  }

  if (variants.length === 0 && storageErrors.length > 0) {
    await supabase.from('layers').delete().eq('id', layer.id);
    return res.status(500).json({ error: `Storage upload failed: ${storageErrors[0]}. Ensure the "layers" bucket exists in Supabase Storage.` });
  }

  res.json({ layer, variants, storageErrors: storageErrors.length ? storageErrors : undefined });
});

// PATCH /api/projects/:id/layers/:layerId — rename or reorder
app.patch('/api/projects/:id/layers/:layerId', async (req, res) => {
  const updates = {};
  if (req.body.name !== undefined) updates.name = req.body.name;
  if (req.body.z_index !== undefined) updates.z_index = Number(req.body.z_index);
  const { data, error } = await supabase.from('layers').update(updates).eq('id', req.params.layerId).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// DELETE /api/projects/:id/layers/:layerId — delete layer (cascades to variants)
app.delete('/api/projects/:id/layers/:layerId', async (req, res) => {
  const { error } = await supabase.from('layers').delete().eq('id', req.params.layerId);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

// POST /api/projects/:id/layers/:layerId/variants — add more variants to existing layer
app.post('/api/projects/:id/layers/:layerId/variants', upload.array('files'), async (req, res) => {
  const { id, layerId } = req.params;
  const variants = [];
  const errors = [];
  for (const file of req.files || []) {
    const filePath = `${id}/${layerId}/${file.originalname}`;
    const { error: uploadErr } = await supabase.storage.from('layers').upload(filePath, file.buffer, { contentType: file.mimetype, upsert: true });
    if (uploadErr) { errors.push(`${file.originalname}: ${uploadErr.message}`); continue; }
    const variantName = path.parse(file.originalname).name;
    const { data: variant } = await supabase.from('variants')
      .insert({ layer_id: layerId, name: variantName, file_path: filePath })
      .select().single();
    if (variant) variants.push(variant);
  }
  if (variants.length === 0 && errors.length > 0) return res.status(400).json({ error: errors[0] });
  res.json({ variants, errors: errors.length ? errors : undefined });
});

// DELETE /api/projects/:id/variants/:variantId
app.delete('/api/projects/:id/variants/:variantId', async (req, res) => {
  const { error } = await supabase.from('variants').delete().eq('id', req.params.variantId);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

// GET /api/projects/:id/incompatibilities — list incompatibility rules for a project
app.get('/api/projects/:id/incompatibilities', async (req, res) => {
  const variantIds = await getVariantIdsForProject(req.params.id);
  if (variantIds.length === 0) return res.json([]);
  const { data, error } = await supabase.from('incompatibilities')
    .select('variant_a, variant_b').in('variant_a', variantIds);
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

async function getVariantIdsForProject(projectId) {
  const { data: layers } = await supabase.from('layers').select('id').eq('project_id', projectId);
  if (!layers || layers.length === 0) return [];
  const { data: variants } = await supabase.from('variants').select('id').in('layer_id', layers.map(l => l.id));
  return (variants || []).map(v => v.id);
}

// GET /api/projects/:id/layers — list layers with variants
app.get('/api/projects/:id/layers', async (req, res) => {
  const { data, error } = await supabase
    .from('layers')
    .select('*, variants(*)')
    .eq('project_id', req.params.id)
    .order('z_index');
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

// PUT /api/projects/:id/variants — save weights + incompatibilities
app.put('/api/projects/:id/variants', async (req, res) => {
  const { variants, incompatibilities } = req.body;

  for (const v of variants || []) {
    await supabase.from('variants').update({ weight: Number(v.weight) || 100, name: v.name }).eq('id', v.id);
  }

  // Replace incompatibilities: delete existing ones for this project's variants, then insert new
  const { data: layers } = await supabase.from('layers').select('id').eq('project_id', req.params.id);
  if (layers && layers.length > 0) {
    const layerIds = layers.map(l => l.id);
    const { data: allVariants } = await supabase.from('variants').select('id').in('layer_id', layerIds);
    const variantIds = (allVariants || []).map(v => v.id);
    if (variantIds.length > 0) {
      await supabase.from('incompatibilities').delete().in('variant_a', variantIds);
    }
  }

  for (const rule of incompatibilities || []) {
    if (rule.variant_a && rule.variant_b && rule.variant_a !== rule.variant_b) {
      await supabase.from('incompatibilities').insert({ variant_a: rule.variant_a, variant_b: rule.variant_b });
    }
  }

  res.json({ ok: true });
});

// POST /api/projects/:id/preview — generate 5 samples
app.post('/api/projects/:id/preview', async (req, res) => {
  try {
    const { generateSamples } = require('./generation');
    const images = await generateSamples(req.params.id, 5);
    res.json({ images });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/projects/:id/generate — queue full generation
app.post('/api/projects/:id/generate', async (req, res) => {
  await supabase.from('projects')
    .update({ status: 'generating', generation_progress: 0 })
    .eq('id', req.params.id);

  if (generationQueue) {
    await generationQueue.add('generate', { projectId: req.params.id });
    res.json({ queued: true, mode: 'async' });
  } else {
    // Run synchronously without queue (no Redis)
    res.json({ queued: true, mode: 'sync' });
    const { generateFull } = require('./generation');
    generateFull(req.params.id).catch(async e => {
      console.error('[generation]', e.message);
      await supabase.from('projects').update({ status: 'error' }).eq('id', req.params.id);
    });
  }
});

// GET /api/projects/:id/status — generation progress
app.get('/api/projects/:id/status', async (req, res) => {
  const { data, error } = await supabase
    .from('projects')
    .select('status, generation_progress, total_supply')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: error.message });

  const { count } = await supabase
    .from('generated_tokens')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', req.params.id);

  res.json({
    status: data.status,
    generated: count || 0,
    total: data.total_supply,
    progress: data.generation_progress || 0,
  });
});

// GET /api/projects/:id/rarity — trait distribution
app.get('/api/projects/:id/rarity', async (req, res) => {
  const { data: layers } = await supabase.from('layers').select('id, name').eq('project_id', req.params.id);
  const { data: tokens } = await supabase.from('generated_tokens').select('traits').eq('project_id', req.params.id);

  const report = {};
  for (const layer of layers || []) {
    report[layer.name] = {};
    for (const token of tokens || []) {
      const traitValue = token.traits?.[layer.name];
      if (traitValue) report[layer.name][traitValue] = (report[layer.name][traitValue] || 0) + 1;
    }
  }
  res.json(report);
});

// GET /api/ipfs/test — test IPFS service connection
app.get('/api/ipfs/test', async (req, res) => {
  try {
    const { testIPFS } = require('./ipfs');
    const result = await testIPFS();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/projects/:id/ipfs — pin to IPFS (NFT.storage or Pinata)
app.post('/api/projects/:id/ipfs', async (req, res) => {
  // Prevent concurrent uploads for the same project
  const { data: proj } = await supabase.from('projects').select('ipfs_phase').eq('id', req.params.id).single();
  if (proj?.ipfs_phase === 'images' || proj?.ipfs_phase === 'metadata') {
    return res.status(409).json({ error: 'Upload already in progress — check the progress bar' });
  }
  try {
    const { pinToIPFS } = require('./ipfs');
    const result = await pinToIPFS(req.params.id);
    const cid = typeof result === 'string' ? result : result.cid;
    const service = typeof result === 'object' ? result.service : undefined;
    res.json({ cid, service });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Marketplace routes ────────────────────────────────────────────────────────
require('./marketplace')(app, supabase);

// ─── Start ────────────────────────────────────────────────────────────────────
async function ensureBuckets() {
  for (const [id, isPublic] of [['layers', false], ['output', true]]) {
    const { error } = await supabase.storage.createBucket(id, { public: isPublic });
    if (!error) console.log(`[storage] created bucket "${id}"`);
    else if (!error.message.includes('already exists')) console.warn(`[storage] bucket "${id}":`, error.message);
  }
}

const PORT = process.env.API_PORT || 3002;
app.listen(PORT, async () => {
  console.log(`Wiznerd API server on http://localhost:${PORT}`);
  await ensureBuckets();
  const { startWatcher } = require('./watcher');
  startWatcher(supabase);
});
