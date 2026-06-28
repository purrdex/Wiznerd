'use strict';
/**
 * Hashlips-style generative engine using @napi-rs/canvas for image compositing.
 * Works fully offline — reads layer images from Supabase Storage, writes output
 * to ./output/, and stores token records in Supabase.
 */
const fs = require('fs');
const path = require('path');

let createCanvas, loadImage;
try {
  ({ createCanvas, loadImage } = require('@napi-rs/canvas'));
} catch {
  console.warn('[generation] @napi-rs/canvas not available — image compositing disabled');
}

// Lazy-require to avoid circular dependency with index.js
function getSupabase() {
  return require('./index').supabase;
}

const OUTPUT_DIR = path.join(__dirname, 'output');
const PREVIEW_DIR = path.join(OUTPUT_DIR, 'preview');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(PREVIEW_DIR)) fs.mkdirSync(PREVIEW_DIR, { recursive: true });

// ─── Trait selection ──────────────────────────────────────────────────────────

function weightedRandom(variants) {
  const total = variants.reduce((sum, v) => sum + (v.weight || 100), 0);
  let rand = Math.random() * total;
  for (const v of variants) {
    rand -= (v.weight || 100);
    if (rand <= 0) return v;
  }
  return variants[variants.length - 1];
}

function isIncompatible(pickedIds, incompatibilities) {
  for (const rule of incompatibilities) {
    if (pickedIds.has(rule.variant_a) && pickedIds.has(rule.variant_b)) return true;
  }
  return false;
}

function pickTraits(layers, incompatibilities) {
  const traits = [];
  for (const layer of layers) {
    if (!layer.variants || layer.variants.length === 0) continue;
    traits.push({ layer, variant: weightedRandom(layer.variants) });
  }
  const ids = new Set(traits.map(t => t.variant.id));
  return isIncompatible(ids, incompatibilities) ? null : traits;
}

function generateTraits(layers, incompatibilities, usedKeys, maxAttempts = 500) {
  for (let i = 0; i < maxAttempts; i++) {
    const traits = pickTraits(layers, incompatibilities);
    if (!traits) continue;
    const key = traits.map(t => t.variant.id).join('|');
    if (usedKeys.has(key)) continue;
    usedKeys.add(key);
    return traits;
  }
  throw new Error(`Could not generate a unique valid combination after ${maxAttempts} attempts`);
}

// ─── Canvas compositing ───────────────────────────────────────────────────────

async function compositeImage(layers, traits, outputPath) {
  if (!createCanvas) throw new Error('Canvas not available');
  const supabase = getSupabase();
  const SIZE = 1000;
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d');

  // Sort by z_index, lowest first (drawn underneath)
  const sortedLayers = [...layers].sort((a, b) => a.z_index - b.z_index);

  for (const layer of sortedLayers) {
    const traitEntry = traits.find(t => t.layer.id === layer.id);
    if (!traitEntry || !traitEntry.variant.file_path) continue;

    try {
      const { data, error } = await supabase.storage
        .from('layers')
        .download(traitEntry.variant.file_path);
      if (error || !data) continue;
      const arrayBuffer = await data.arrayBuffer();
      const img = await loadImage(Buffer.from(arrayBuffer));
      ctx.drawImage(img, 0, 0, SIZE, SIZE);
    } catch (e) {
      console.warn(`[generation] skipping layer "${layer.name}":`, e.message);
    }
  }

  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(outputPath, buffer);
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function fetchProjectData(projectId) {
  const supabase = getSupabase();

  const [{ data: project }, { data: layers }, { data: incompatibilities }] = await Promise.all([
    supabase.from('projects').select('*').eq('id', projectId).single(),
    supabase.from('layers').select('*, variants(*)').eq('project_id', projectId).order('z_index'),
    supabase.from('incompatibilities')
      .select('variant_a, variant_b')
      .in('variant_a', await getVariantIds(projectId)),
  ]);

  return { project, layers: layers || [], incompatibilities: incompatibilities || [] };
}

async function getVariantIds(projectId) {
  const supabase = getSupabase();
  const { data: layers } = await supabase.from('layers').select('id').eq('project_id', projectId);
  const layerIds = (layers || []).map(l => l.id);
  if (layerIds.length === 0) return ['00000000-0000-0000-0000-000000000000'];
  const { data: variants } = await supabase.from('variants').select('id').in('layer_id', layerIds);
  return (variants || []).map(v => v.id);
}

async function generateSamples(projectId, count) {
  const { layers, incompatibilities } = await fetchProjectData(projectId);
  const previewDir = path.join(PREVIEW_DIR, projectId);
  if (!fs.existsSync(previewDir)) fs.mkdirSync(previewDir, { recursive: true });

  const usedKeys = new Set();
  const urls = [];

  for (let i = 0; i < count; i++) {
    const traits = generateTraits(layers, incompatibilities, usedKeys);
    const filePath = path.join(previewDir, `${i}.png`);

    if (createCanvas) {
      await compositeImage(layers, traits, filePath);
    } else {
      // Placeholder: create a coloured 1x1 PNG when canvas unavailable
      fs.writeFileSync(filePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
    }

    urls.push(`http://localhost:3002/output/preview/${projectId}/${i}.png`);
  }

  return urls;
}

async function generateFull(projectId) {
  const supabase = getSupabase();
  const { project, layers, incompatibilities } = await fetchProjectData(projectId);
  const total = project.total_supply;
  const projectOutputDir = path.join(OUTPUT_DIR, projectId);
  if (!fs.existsSync(projectOutputDir)) fs.mkdirSync(projectOutputDir, { recursive: true });

  const usedKeys = new Set();

  for (let i = 0; i < total; i++) {
    const traits = generateTraits(layers, incompatibilities, usedKeys);
    const filePath = path.join(projectOutputDir, `${i}.png`);

    // Composite image
    if (createCanvas) {
      await compositeImage(layers, traits, filePath);
    } else {
      fs.writeFileSync(filePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
    }

    // Build traits JSONB: { layerName: variantName }
    const traitsJson = {};
    for (const t of traits) traitsJson[t.layer.name] = t.variant.name;

    // Upload to Supabase Storage 'output' bucket
    const storagePath = `${projectId}/${i}.png`;
    const fileBuffer = fs.readFileSync(filePath);
    await supabase.storage.from('output').upload(storagePath, fileBuffer, { contentType: 'image/png', upsert: true });

    // Insert generated_token record
    await supabase.from('generated_tokens').insert({
      project_id: projectId,
      token_index: i,
      traits: traitsJson,
      image_path: storagePath,
      status: 'generated',
    });

    // Update progress every 5 tokens or on completion
    if (i % 5 === 0 || i === total - 1) {
      const progress = Math.round(((i + 1) / total) * 100);
      await supabase.from('projects').update({ generation_progress: progress }).eq('id', projectId);
    }
  }

  await supabase.from('projects').update({ status: 'complete', generation_progress: 100 }).eq('id', projectId);
}

module.exports = { generateSamples, generateFull };
