import { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:3002';

// ─── Types ────────────────────────────────────────────────────────────────────
interface Variant { id: string; name: string; weight: number; file_path: string | null; }
interface Layer { id: string; name: string; z_index: number; variants: Variant[]; }
interface Project {
  id: string; name: string; symbol: string;
  total_supply: number; royalty_percent: number; status: string;
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const S: Record<string, React.CSSProperties> = {
  page:   { minHeight: '100vh', background: '#0a0b0f', color: '#e2e8f0', fontFamily: 'system-ui, sans-serif', padding: 24 },
  card:   { background: '#161720', border: '1px solid #2d2f3d', borderRadius: 12, padding: 24, maxWidth: 720, margin: '0 auto' },
  input:  { width: '100%', boxSizing: 'border-box', padding: '10px 14px', background: '#0f1016', border: '1px solid #2d2f3d', borderRadius: 8, color: '#e2e8f0', fontSize: 14 },
  select: { width: '100%', boxSizing: 'border-box', padding: '9px 12px', background: '#0f1016', border: '1px solid #2d2f3d', borderRadius: 8, color: '#e2e8f0', fontSize: 13 },
  btnP:   { padding: '11px 24px', background: '#f97316', border: 'none', borderRadius: 8, color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  btnS:   { padding: '9px 18px', background: 'none', border: '1px solid #2d2f3d', borderRadius: 8, color: '#94a3b8', fontSize: 13, cursor: 'pointer' },
  row:    { display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 },
  label:  { fontSize: 12, color: '#64748b', display: 'block', marginBottom: 4 },
  err:    { background: 'rgba(220,50,50,0.1)', border: '1px solid rgba(220,50,50,0.3)', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#f87171' },
};

const STEPS = ['Project','Layers','Traits','Preview','Generate','Rarity','IPFS','Launch'];

// ─── Main component ───────────────────────────────────────────────────────────
export default function CreateScreen() {
  const [step, setStep] = useState(1);
  const [project, setProject] = useState<Project | null>(null);
  const [layers, setLayers] = useState<Layer[]>([]);
  const [incompatA, setIncompatA] = useState('');
  const [incompatB, setIncompatB] = useState('');
  const [incompats, setIncompats] = useState<{ a: string; b: string }[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [genProgress, setGenProgress] = useState(0);
  const [genStatus, setGenStatus] = useState('');
  const [rarityData, setRarityData] = useState<Record<string, Record<string, number>>>({});
  const [ipfsCid, setIpfsCid] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Step 1 fields
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [supply, setSupply] = useState(100);
  const [royalty, setRoyalty] = useState(5);

  // Step 2 — layer upload & management
  const [newLayerName, setNewLayerName] = useState('');
  const [uploadingLayer, setUploadingLayer] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [dragOverNew, setDragOverNew] = useState(false);
  const [dragOverLayerId, setDragOverLayerId] = useState<string | null>(null);
  const [expandedInStep2, setExpandedInStep2] = useState<Set<string>>(new Set());
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const [editLayerNameVal, setEditLayerNameVal] = useState('');
  const [addVariantTargetId, setAddVariantTargetId] = useState<string | null>(null);
  const newLayerFileInputRef = useRef<HTMLInputElement>(null);
  const addVariantFileInputRef = useRef<HTMLInputElement>(null);

  // Step 3 — expanded layers
  const [expandedLayers, setExpandedLayers] = useState<Set<string>>(new Set());
  const toggleLayer = (id: string) => setExpandedLayers(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  // Generation poll ref
  const genPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (genPollRef.current) clearInterval(genPollRef.current); }, []);

  // Auto-set incompat selects when layers load; auto-expand all layers on step 3
  useEffect(() => {
    const first = layers.flatMap(l => l.variants)[0];
    if (first && !incompatA) { setIncompatA(first.id); setIncompatB(first.id); }
  }, [layers, incompatA]);

  useEffect(() => {
    if (step === 3) setExpandedLayers(new Set(layers.map(l => l.id)));
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch rarity data when entering step 6
  useEffect(() => {
    if (step !== 6 || !project) return;
    fetch(`${API_URL}/api/projects/${project.id}/rarity`, { signal: AbortSignal.timeout(10000) })
      .then(r => r.json())
      .then(d => setRarityData(d as Record<string, Record<string, number>>))
      .catch(() => {});
  }, [step, project]);

  // Subscribe to Supabase Realtime for generation progress
  useEffect(() => {
    if (step !== 5 || !project) return;
    const channel = supabase
      .channel(`project-${project.id}`)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'projects',
        filter: `id=eq.${project.id}`,
      }, payload => {
        const p = payload.new as { generation_progress: number; status: string };
        setGenProgress(p.generation_progress ?? 0);
        if (p.status === 'complete') {
          setGenStatus('Complete!');
          setBusy(false);
          if (genPollRef.current) { clearInterval(genPollRef.current); genPollRef.current = null; }
        } else if (p.status === 'error') {
          setGenStatus('Error');
          setError('Generation failed — check server logs');
          setBusy(false);
        }
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [step, project]);

  // ─── Handlers ──────────────────────────────────────────────────────────────

  async function handleCreateProject() {
    if (!name || !symbol) return;
    setBusy(true); setError('');
    try {
      const res = await fetch(`${API_URL}/api/projects`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, symbol, total_supply: supply, royalty_percent: royalty }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json() as Project;
      if (!res.ok) throw new Error((data as unknown as { error: string }).error);
      setProject(data);
      setStep(2);
    } catch (e: unknown) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function handleAddLayer() {
    if (!newLayerName.trim() || !project) return;
    if (pendingFiles.length === 0) { setError('Add at least one PNG file to this layer'); return; }
    setUploadingLayer(true); setError('');
    try {
      const formData = new FormData();
      formData.append('layer_name', newLayerName.trim());
      formData.append('z_index', String(layers.length));
      for (const f of pendingFiles) formData.append('files', f);
      const res = await fetch(`${API_URL}/api/projects/${project.id}/layers`, {
        method: 'POST', body: formData, signal: AbortSignal.timeout(60000),
      });
      const data = await res.json() as { layer: Layer; variants: Variant[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Upload failed');
      if (data.variants.length === 0) throw new Error('No variants were saved — verify the "layers" bucket exists in Supabase Storage with correct permissions');
      setLayers(prev => [...prev, { ...data.layer, variants: data.variants }]);
      setExpandedInStep2(prev => new Set([...prev, data.layer.id]));
      setNewLayerName('');
      setPendingFiles([]);
    } catch (e: unknown) { setError((e as Error).message); }
    finally { setUploadingLayer(false); }
  }

  async function handleDeleteLayer(layerId: string) {
    if (!project || !window.confirm('Delete this layer and all its variants?')) return;
    setError('');
    try {
      const res = await fetch(`${API_URL}/api/projects/${project.id}/layers/${layerId}`, {
        method: 'DELETE', signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error('Delete failed');
      setLayers(prev => prev.filter(l => l.id !== layerId).map((l, i) => ({ ...l, z_index: i })));
    } catch (e: unknown) { setError((e as Error).message); }
  }

  async function handleSaveLayerName(layerId: string) {
    if (!project || !editLayerNameVal.trim()) { setEditingLayerId(null); return; }
    try {
      await fetch(`${API_URL}/api/projects/${project.id}/layers/${layerId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editLayerNameVal.trim() }),
        signal: AbortSignal.timeout(10000),
      });
      setLayers(prev => prev.map(l => l.id === layerId ? { ...l, name: editLayerNameVal.trim() } : l));
    } catch (e: unknown) { setError((e as Error).message); }
    finally { setEditingLayerId(null); }
  }

  async function handleMoveLayer(layerId: string, dir: -1 | 1) {
    if (!project) return;
    const idx = layers.findIndex(l => l.id === layerId);
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= layers.length) return;
    const next = [...layers];
    [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
    setLayers(next.map((l, i) => ({ ...l, z_index: i })));
    await Promise.all([
      fetch(`${API_URL}/api/projects/${project.id}/layers/${next[idx].id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ z_index: idx }), signal: AbortSignal.timeout(5000),
      }),
      fetch(`${API_URL}/api/projects/${project.id}/layers/${next[newIdx].id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ z_index: newIdx }), signal: AbortSignal.timeout(5000),
      }),
    ]);
  }

  async function handleDeleteVariant(layerId: string, variantId: string) {
    if (!project) return;
    try {
      await fetch(`${API_URL}/api/projects/${project.id}/variants/${variantId}`, {
        method: 'DELETE', signal: AbortSignal.timeout(10000),
      });
      setLayers(prev => prev.map(l => l.id === layerId
        ? { ...l, variants: l.variants.filter(v => v.id !== variantId) } : l));
    } catch (e: unknown) { setError((e as Error).message); }
  }

  async function handleAddVariants(layerId: string, files: File[]) {
    if (!project || files.length === 0) return;
    setUploadingLayer(true); setError('');
    try {
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      const res = await fetch(`${API_URL}/api/projects/${project.id}/layers/${layerId}/variants`, {
        method: 'POST', body: fd, signal: AbortSignal.timeout(60000),
      });
      const data = await res.json() as { variants: Variant[]; errors?: string[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Upload failed');
      setLayers(prev => prev.map(l => l.id === layerId
        ? { ...l, variants: [...l.variants, ...data.variants] } : l));
      if (data.errors?.length) setError(`Some files failed: ${data.errors.join('; ')}`);
    } catch (e: unknown) { setError((e as Error).message); }
    finally { setUploadingLayer(false); }
  }

  async function handleSaveTraits() {
    if (!project) return;
    setBusy(true); setError('');
    try {
      const allVariants = layers.flatMap(l => l.variants);
      const res = await fetch(`${API_URL}/api/projects/${project.id}/variants`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variants: allVariants, incompatibilities: incompats.map(i => ({ variant_a: i.a, variant_b: i.b })) }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error('Save failed');
      setStep(4);
    } catch (e: unknown) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function handlePreview() {
    if (!project) return;
    setBusy(true); setError(''); setPreviews([]);
    try {
      const res = await fetch(`${API_URL}/api/projects/${project.id}/preview`, {
        method: 'POST', signal: AbortSignal.timeout(120000),
      });
      const data = await res.json() as { images?: string[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Preview failed');
      setPreviews(data.images ?? []);
    } catch (e: unknown) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function handleGenerate() {
    if (!project) return;
    setBusy(true); setError(''); setGenProgress(0); setGenStatus('Queuing…');
    try {
      const res = await fetch(`${API_URL}/api/projects/${project.id}/generate`, {
        method: 'POST', signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error((await res.json() as { error: string }).error);
      setGenStatus('Generating…');

      // Fallback poll (Realtime is primary; poll ensures progress if Realtime drops)
      genPollRef.current = setInterval(async () => {
        try {
          const r = await fetch(`${API_URL}/api/projects/${project.id}/status`, { signal: AbortSignal.timeout(5000) });
          const d = await r.json() as { status: string; progress: number };
          setGenProgress(d.progress ?? 0);
          if (d.status === 'complete') {
            clearInterval(genPollRef.current!); genPollRef.current = null;
            setGenStatus('Complete!'); setBusy(false);
          } else if (d.status === 'error') {
            clearInterval(genPollRef.current!); genPollRef.current = null;
            setError('Generation failed'); setBusy(false);
          }
        } catch { /* poll errors are transient */ }
      }, 3000);
    } catch (e: unknown) { setError((e as Error).message); setBusy(false); }
  }

  async function handleIpfsPin() {
    if (!project) return;
    setBusy(true); setError('');
    try {
      const res = await fetch(`${API_URL}/api/projects/${project.id}/ipfs`, {
        method: 'POST', signal: AbortSignal.timeout(300000),
      });
      const data = await res.json() as { cid?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'IPFS pin failed');
      setIpfsCid(data.cid ?? '');
      setStep(8);
    } catch (e: unknown) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  // ─── Render ─────────────────────────────────────────────────────────────────
  const allVariants = layers.flatMap(l =>
    l.variants.map(v => ({ ...v, layerName: l.name }))
  );

  return (
    <div style={S.page}>
      {/* Header */}
      <div style={{ maxWidth: 720, margin: '0 auto 28px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
          <img src="/tepe.png" alt="Wiznerd mascot" style={{ width: 64, height: 64, borderRadius: '50%' }} />
          <div style={{ textAlign: 'center' }}>
            <h1 style={{ margin: 0, fontSize: 28, fontWeight: 700, color: '#fff' }}>Wiznerd Art Studio</h1>
            <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: 13 }}>Create, configure, and launch your Chia NFT collection</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4, marginTop: 18 }}>
          {STEPS.map((label, i) => (
            <div key={i} style={{ flex: 1 }}>
              <div style={{ height: 4, borderRadius: 2, marginBottom: 4,
                background: step > i + 1 ? '#f97316' : step === i + 1 ? '#fb923c' : '#1e2030' }} />
              <span style={{ fontSize: 9, color: step === i + 1 ? '#fb923c' : '#334155', display: 'block', textAlign: 'center' }}>
                {label}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div style={S.card}>
        {error && <div style={S.err}>{error}</div>}

        {/* ── Step 1: New Project ─────────────────────────────────────────── */}
        {step === 1 && (
          <div>
            <h2 style={{ margin: '0 0 18px', fontSize: 18 }}>New Project</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <span style={S.label}>Collection name</span>
                <input style={S.input} placeholder="e.g. Wiznerd Wizards" value={name} onChange={e => setName(e.target.value)} />
              </div>
              <div>
                <span style={S.label}>Symbol</span>
                <input style={S.input} placeholder="e.g. WZNRD" value={symbol} maxLength={8}
                  onChange={e => setSymbol(e.target.value.toUpperCase())} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <span style={S.label}>Total supply</span>
                  <input style={S.input} type="number" value={supply} min={1} max={10000}
                    onChange={e => setSupply(Math.max(1, Math.min(10000, +e.target.value)))} />
                </div>
                <div>
                  <span style={S.label}>Royalty %</span>
                  <input style={S.input} type="number" value={royalty} min={0} max={15}
                    onChange={e => setRoyalty(Math.max(0, Math.min(15, +e.target.value)))} />
                </div>
              </div>
              <button style={{ ...S.btnP, marginTop: 4 }} onClick={handleCreateProject} disabled={busy || !name || !symbol}>
                {busy ? 'Creating…' : 'Create Project →'}
              </button>
            </div>
          </div>
        )}

        {/* ── Step 2: Layer Upload ────────────────────────────────────────── */}
        {step === 2 && (
          <div>
            <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>Upload Layers</h2>
            <p style={{ margin: '0 0 18px', fontSize: 13, color: '#64748b' }}>
              Layers stack bottom-to-top (z=0 = Background, highest = foreground accessories). Each PNG = one variant.
            </p>

            {/* Hidden file inputs */}
            <input ref={newLayerFileInputRef} type="file" accept="image/png" multiple style={{ display: 'none' }}
              onChange={e => { if (e.target.files) { setPendingFiles(prev => [...prev, ...Array.from(e.target.files!)]); e.target.value = ''; } }} />
            <input ref={addVariantFileInputRef} type="file" accept="image/png" multiple style={{ display: 'none' }}
              onChange={e => {
                if (e.target.files && addVariantTargetId) {
                  handleAddVariants(addVariantTargetId, Array.from(e.target.files));
                  e.target.value = '';
                }
              }} />

            {/* Existing layers list */}
            {layers.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                {layers.map((layer, idx) => {
                  const isExp = expandedInStep2.has(layer.id);
                  const isEd = editingLayerId === layer.id;
                  return (
                    <div key={layer.id} style={{ border: '1px solid #1e2030', borderRadius: 8, marginBottom: 8, overflow: 'hidden' }}>
                      {/* Layer header row */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: '#0f1016' }}>
                        {/* Up / Down */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 }}>
                          <button onClick={() => handleMoveLayer(layer.id, -1)} disabled={idx === 0}
                            style={{ ...S.btnS, padding: '1px 5px', fontSize: 9, lineHeight: 1.2, opacity: idx === 0 ? 0.3 : 1 }}>▲</button>
                          <button onClick={() => handleMoveLayer(layer.id, 1)} disabled={idx === layers.length - 1}
                            style={{ ...S.btnS, padding: '1px 5px', fontSize: 9, lineHeight: 1.2, opacity: idx === layers.length - 1 ? 0.3 : 1 }}>▼</button>
                        </div>
                        {/* Index badge */}
                        <span style={{ fontSize: 10, color: '#334155', background: '#1e2030', borderRadius: 4, padding: '2px 5px', flexShrink: 0 }}>{idx + 1}</span>
                        {/* Name / edit */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          {isEd ? (
                            <input autoFocus value={editLayerNameVal}
                              onChange={e => setEditLayerNameVal(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') handleSaveLayerName(layer.id); if (e.key === 'Escape') setEditingLayerId(null); }}
                              onBlur={() => handleSaveLayerName(layer.id)}
                              style={{ ...S.input, padding: '4px 8px', fontSize: 13 }} />
                          ) : (
                            <span style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>{layer.name}
                              <span style={{ fontWeight: 400, color: '#334155', fontSize: 11, marginLeft: 6 }}>
                                {layer.variants.length} variant{layer.variants.length !== 1 ? 's' : ''}
                              </span>
                            </span>
                          )}
                        </div>
                        {/* Action buttons */}
                        {!isEd && (
                          <button onClick={() => { setEditingLayerId(layer.id); setEditLayerNameVal(layer.name); }}
                            style={{ ...S.btnS, padding: '3px 9px', fontSize: 11, flexShrink: 0 }}>Rename</button>
                        )}
                        <button onClick={() => handleDeleteLayer(layer.id)}
                          style={{ ...S.btnS, padding: '3px 9px', fontSize: 11, color: '#f87171', borderColor: 'rgba(248,113,113,0.3)', flexShrink: 0 }}>Delete</button>
                        <button
                          onClick={() => setExpandedInStep2(prev => { const n = new Set(prev); n.has(layer.id) ? n.delete(layer.id) : n.add(layer.id); return n; })}
                          style={{ ...S.btnS, padding: '3px 8px', fontSize: 11, flexShrink: 0 }}>{isExp ? '▲' : '▼'}</button>
                      </div>

                      {/* Expanded: variant list + add-more drop zone */}
                      {isExp && (
                        <div style={{ padding: '10px 12px', borderTop: '1px solid #1e2030' }}>
                          {layer.variants.map(v => (
                            <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7, padding: '6px 8px', background: '#0a0b0f', borderRadius: 6 }}>
                              {v.file_path && (
                                <img src={`${API_URL}/api/thumb?path=${encodeURIComponent(v.file_path)}`} alt={v.name}
                                  style={{ width: 40, height: 40, borderRadius: 4, objectFit: 'cover', flexShrink: 0, border: '1px solid #1e2030' }} />
                              )}
                              <input value={v.name}
                                onChange={e => setLayers(prev => prev.map(l => l.id === layer.id
                                  ? { ...l, variants: l.variants.map(vv => vv.id === v.id ? { ...vv, name: e.target.value } : vv) }
                                  : l))}
                                style={{ flex: 1, padding: '4px 8px', background: '#0f1016', border: '1px solid #2d2f3d', borderRadius: 5, color: '#e2e8f0', fontSize: 12 }} />
                              <button onClick={() => handleDeleteVariant(layer.id, v.id)}
                                style={{ ...S.btnS, padding: '3px 9px', fontSize: 11, color: '#f87171', borderColor: 'rgba(248,113,113,0.3)', flexShrink: 0 }}>Remove</button>
                            </div>
                          ))}
                          {/* Drop zone for more variants */}
                          <div
                            onDragOver={e => { e.preventDefault(); setDragOverLayerId(layer.id); }}
                            onDragLeave={() => setDragOverLayerId(null)}
                            onDrop={e => { e.preventDefault(); setDragOverLayerId(null); handleAddVariants(layer.id, Array.from(e.dataTransfer.files).filter(f => f.type === 'image/png')); }}
                            onClick={() => { setAddVariantTargetId(layer.id); addVariantFileInputRef.current?.click(); }}
                            style={{
                              border: `1px dashed ${dragOverLayerId === layer.id ? '#f97316' : '#2d2f3d'}`,
                              borderRadius: 6, padding: '10px', textAlign: 'center', cursor: 'pointer',
                              background: dragOverLayerId === layer.id ? 'rgba(249,115,22,0.05)' : 'transparent',
                              marginTop: 6, fontSize: 12, color: '#475569', transition: 'all 0.15s',
                            }}>
                            {uploadingLayer ? 'Uploading…' : '+ Drop PNGs or click to add more variants'}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Add new layer */}
            <div style={{ border: '1px solid #2d2f3d', borderRadius: 8, padding: 16, background: '#0f1016' }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#475569', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>New Layer</div>
              <input style={{ ...S.input, marginBottom: 10 }}
                placeholder="Layer name (e.g. Background, Eyes, Hat)"
                value={newLayerName} onChange={e => setNewLayerName(e.target.value)} />

              {/* Drop zone */}
              <div
                onDragOver={e => { e.preventDefault(); setDragOverNew(true); }}
                onDragLeave={() => setDragOverNew(false)}
                onDrop={e => { e.preventDefault(); setDragOverNew(false); setPendingFiles(prev => [...prev, ...Array.from(e.dataTransfer.files).filter(f => f.type === 'image/png')]); }}
                onClick={() => newLayerFileInputRef.current?.click()}
                style={{
                  border: `2px dashed ${dragOverNew ? '#f97316' : '#2d2f3d'}`,
                  borderRadius: 8, padding: '26px 16px', textAlign: 'center', cursor: 'pointer',
                  background: dragOverNew ? 'rgba(249,115,22,0.05)' : '#0a0b0f',
                  transition: 'all 0.15s ease', marginBottom: 10,
                }}>
                <div style={{ fontSize: 20, marginBottom: 6 }}>🖼️</div>
                <div style={{ fontSize: 13, color: dragOverNew ? '#f97316' : '#64748b' }}>Drop PNG files here or click to browse</div>
                <div style={{ fontSize: 11, color: '#334155', marginTop: 3 }}>Each PNG becomes one variant (red.png, blue.png…)</div>
              </div>

              {/* Pending file chips */}
              {pendingFiles.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 12 }}>
                  {pendingFiles.map((f, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', background: '#161720', border: '1px solid #2d2f3d', borderRadius: 5, fontSize: 11, color: '#94a3b8' }}>
                      {f.name}
                      <button onClick={e => { e.stopPropagation(); setPendingFiles(prev => prev.filter((_, j) => j !== i)); }}
                        style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', padding: 0, marginLeft: 2, fontSize: 14, lineHeight: 1 }}>×</button>
                    </div>
                  ))}
                </div>
              )}

              <button style={{ ...S.btnP, opacity: uploadingLayer || !newLayerName.trim() || pendingFiles.length === 0 ? 0.5 : 1 }}
                onClick={handleAddLayer}
                disabled={uploadingLayer || !newLayerName.trim() || pendingFiles.length === 0}>
                {uploadingLayer ? 'Uploading…' : `+ Add Layer${pendingFiles.length > 0 ? ` (${pendingFiles.length} file${pendingFiles.length !== 1 ? 's' : ''})` : ''}`}
              </button>
            </div>

            <div style={S.row}>
              <button style={S.btnS} onClick={() => setStep(1)}>← Back</button>
              <button style={S.btnP} onClick={() => { setError(''); setStep(3); }} disabled={layers.length === 0}>
                Configure Traits →
              </button>
            </div>
          </div>
        )}

        {/* ── Step 3: Trait Config ────────────────────────────────────────── */}
        {step === 3 && (
          <div>
            <h2 style={{ margin: '0 0 6px', fontSize: 18 }}>Trait Configuration</h2>
            <p style={{ margin: '0 0 18px', fontSize: 13, color: '#64748b' }}>
              Click a layer to expand it. Set rarity weights (higher = more common) and mark incompatible variant pairs below.
            </p>

            {layers.map(layer => {
              const isExpanded = expandedLayers.has(layer.id);
              const total = layer.variants.reduce((s, v) => s + (v.weight || 100), 0);
              return (
                <div key={layer.id} style={{ marginBottom: 8, border: '1px solid #1e2030', borderRadius: 8, overflow: 'hidden' }}>
                  {/* Clickable layer header */}
                  <div onClick={() => toggleLayer(layer.id)} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '12px 16px', cursor: 'pointer', background: '#0f1016', userSelect: 'none',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#f97316' }}>{layer.name}</span>
                      <span style={{ fontSize: 11, color: '#475569' }}>
                        {layer.variants.length} variant{layer.variants.length !== 1 ? 's' : ''}
                      </span>
                    </div>
                    <span style={{ color: '#475569', fontSize: 11 }}>{isExpanded ? '▲' : '▼'}</span>
                  </div>

                  {/* Variants — visible when expanded */}
                  {isExpanded && (
                    <div style={{ padding: '10px 16px 14px', borderTop: '1px solid #1e2030' }}>
                      {layer.variants.map(variant => (
                        <div key={variant.id} style={{
                          display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8,
                          padding: '8px 10px', background: '#0a0b0f', borderRadius: 6,
                        }}>
                          {variant.file_path && (
                            <img
                              src={`${API_URL}/api/thumb?path=${encodeURIComponent(variant.file_path)}`}
                              alt={variant.name}
                              style={{ width: 44, height: 44, borderRadius: 4, objectFit: 'cover', flexShrink: 0, border: '1px solid #1e2030' }}
                            />
                          )}
                          <span style={{ flex: 1, fontSize: 13, color: '#94a3b8' }}>{variant.name}</span>
                          <span style={{ ...S.label, margin: 0 }}>Wt</span>
                          <input type="number" min={1} max={1000} value={variant.weight || 100}
                            onChange={e => setLayers(prev => prev.map(l => l.id === layer.id ? {
                              ...l, variants: l.variants.map(v => v.id === variant.id
                                ? { ...v, weight: Math.max(1, +e.target.value) } : v),
                            } : l))}
                            style={{ width: 68, padding: '6px 8px', background: '#0f1016', border: '1px solid #2d2f3d', borderRadius: 6, color: '#e2e8f0', fontSize: 13 }}
                          />
                          <span style={{ fontSize: 11, color: '#475569', width: 36, textAlign: 'right' }}>
                            {total > 0 ? Math.round((variant.weight || 100) / total * 100) : 0}%
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Incompatibilities */}
            <div style={{ borderTop: '1px solid #1e2030', paddingTop: 16, marginTop: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Incompatibility Rules</div>

              {incompats.map((rule, i) => {
                const va = allVariants.find(v => v.id === rule.a);
                const vb = allVariants.find(v => v.id === rule.b);
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 12 }}>
                    <span style={{ flex: 1, color: '#94a3b8' }}>
                      {va ? `${va.layerName}: ${va.name}` : '?'} &times; {vb ? `${vb.layerName}: ${vb.name}` : '?'}
                    </span>
                    <button style={{ ...S.btnS, padding: '3px 10px', fontSize: 11 }}
                      onClick={() => setIncompats(prev => prev.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  </div>
                );
              })}

              {allVariants.length >= 2 && (
                <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <select style={{ ...S.select, flex: 1 }} value={incompatA} onChange={e => setIncompatA(e.target.value)}>
                    {allVariants.map(v => <option key={v.id} value={v.id}>{v.layerName}: {v.name}</option>)}
                  </select>
                  <span style={{ color: '#475569', fontSize: 12 }}>×</span>
                  <select style={{ ...S.select, flex: 1 }} value={incompatB} onChange={e => setIncompatB(e.target.value)}>
                    {allVariants.map(v => <option key={v.id} value={v.id}>{v.layerName}: {v.name}</option>)}
                  </select>
                  <button style={S.btnS} onClick={() => {
                    if (incompatA && incompatB && incompatA !== incompatB)
                      setIncompats(prev => [...prev, { a: incompatA, b: incompatB }]);
                  }}>Add</button>
                </div>
              )}
            </div>

            <div style={S.row}>
              <button style={S.btnS} onClick={() => setStep(2)}>← Back</button>
              <button style={S.btnP} onClick={handleSaveTraits} disabled={busy}>
                {busy ? 'Saving…' : 'Save & Preview →'}
              </button>
            </div>
          </div>
        )}

        {/* ── Step 4: Preview ─────────────────────────────────────────────── */}
        {step === 4 && (
          <div>
            <h2 style={{ margin: '0 0 6px', fontSize: 18 }}>Preview</h2>
            <p style={{ margin: '0 0 18px', fontSize: 13, color: '#64748b' }}>
              Generate 5 sample NFTs to verify your layers and rarity weights.
            </p>

            {previews.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginBottom: 20 }}>
                {previews.map((url, i) => (
                  <img key={i} src={url} alt={`Preview ${i + 1}`}
                    style={{ width: '100%', aspectRatio: '1', borderRadius: 6, objectFit: 'cover', border: '1px solid #1e2030' }} />
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <button style={S.btnP} onClick={handlePreview} disabled={busy}>
                {busy ? 'Generating…' : previews.length > 0 ? 'Regenerate' : 'Generate 5 Previews'}
              </button>
            </div>

            <div style={S.row}>
              <button style={S.btnS} onClick={() => setStep(3)}>← Back</button>
              <button style={S.btnP} onClick={() => setStep(5)} disabled={previews.length === 0}>
                Generate Full Collection →
              </button>
            </div>
          </div>
        )}

        {/* ── Step 5: Generate ────────────────────────────────────────────── */}
        {step === 5 && (
          <div>
            <h2 style={{ margin: '0 0 6px', fontSize: 18 }}>Generate Collection</h2>
            <p style={{ margin: '0 0 18px', fontSize: 13, color: '#64748b' }}>
              Composite all {project?.total_supply} unique NFT images. Progress is tracked live via Supabase Realtime.
            </p>

            {genStatus ? (
              <>
                <div style={{ marginBottom: 20 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: 13 }}>
                    <span style={{ color: '#94a3b8' }}>{genStatus}</span>
                    <span style={{ color: '#fb923c', fontWeight: 600 }}>{genProgress}%</span>
                  </div>
                  <div style={{ height: 8, background: '#0f1016', borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{ height: '100%', borderRadius: 4, transition: 'width 0.5s ease',
                      width: `${genProgress}%`, background: 'linear-gradient(90deg, #ea580c, #f97316)' }} />
                  </div>
                </div>
                {genStatus === 'Complete!' && (
                  <button style={S.btnP} onClick={() => setStep(6)}>View Rarity Report →</button>
                )}
              </>
            ) : (
              <button style={S.btnP} onClick={handleGenerate} disabled={busy}>
                🚀 Start Generation
              </button>
            )}

            <div style={S.row}>
              <button style={S.btnS} onClick={() => setStep(4)} disabled={busy}>← Back</button>
            </div>
          </div>
        )}

        {/* ── Step 6: Rarity Report ───────────────────────────────────────── */}
        {step === 6 && (
          <div>
            <h2 style={{ margin: '0 0 6px', fontSize: 18 }}>Rarity Report</h2>
            <p style={{ margin: '0 0 18px', fontSize: 13, color: '#64748b' }}>
              Trait distribution across the generated collection.
            </p>

            {Object.keys(rarityData).length === 0 ? (
              <div style={{ color: '#475569', fontSize: 13 }}>Loading rarity data…</div>
            ) : (
              Object.entries(rarityData).map(([layerName, traitCounts]) => {
                const chartData = Object.entries(traitCounts).map(([n, count]) => ({ name: n, count }));
                return (
                  <div key={layerName} style={{ marginBottom: 32 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#f97316', marginBottom: 10 }}>{layerName}</div>
                    <ResponsiveContainer width="100%" height={150}>
                      <BarChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e2030" />
                        <XAxis dataKey="name" tick={{ fill: '#475569', fontSize: 11 }} />
                        <YAxis tick={{ fill: '#475569', fontSize: 11 }} />
                        <Tooltip
                          contentStyle={{ background: '#161720', border: '1px solid #2d2f3d', borderRadius: 6, fontSize: 12 }}
                          labelStyle={{ color: '#e2e8f0' }}
                        />
                        <Bar dataKey="count" fill="#f97316" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                );
              })
            )}

            <div style={S.row}>
              <button style={S.btnP} onClick={() => setStep(7)}>Pin to IPFS →</button>
            </div>
          </div>
        )}

        {/* ── Step 7: IPFS ────────────────────────────────────────────────── */}
        {step === 7 && (
          <div>
            <h2 style={{ margin: '0 0 6px', fontSize: 18 }}>Pin to IPFS</h2>
            <p style={{ margin: '0 0 18px', fontSize: 13, color: '#64748b' }}>
              Upload all images and CHIP-0007 metadata JSON to NFT.storage for permanent hosting.
              Requires <code style={{ fontSize: 11 }}>NFT_STORAGE_KEY</code> in <code style={{ fontSize: 11 }}>.env</code>.
            </p>

            {ipfsCid ? (
              <div style={{ background: 'rgba(249,115,22,0.08)', border: '1px solid rgba(249,115,22,0.3)', borderRadius: 8, padding: '12px 16px', marginBottom: 16 }}>
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>IPFS CID</div>
                <div style={{ fontSize: 13, fontFamily: 'monospace', color: '#fb923c', wordBreak: 'break-all' }}>{ipfsCid}</div>
              </div>
            ) : (
              <button style={S.btnP} onClick={handleIpfsPin} disabled={busy}>
                {busy ? 'Pinning…' : '📌 Pin to IPFS'}
              </button>
            )}

            <div style={S.row}>
              <button style={S.btnS} onClick={() => setStep(6)}>← Back</button>
              {ipfsCid && <button style={S.btnP} onClick={() => setStep(8)}>Launch →</button>}
            </div>
          </div>
        )}

        {/* ── Step 8: Launch ──────────────────────────────────────────────── */}
        {step === 8 && (
          <div style={{ textAlign: 'center', padding: '32px 0' }}>
            <div style={{ fontSize: 56, marginBottom: 16 }}>🎉</div>
            <h2 style={{ margin: '0 0 12px', fontSize: 22, color: '#fff' }}>Collection Ready!</h2>
            <p style={{ color: '#64748b', marginBottom: 8, lineHeight: 1.6, fontSize: 14 }}>
              <strong style={{ color: '#e2e8f0' }}>{project?.name}</strong> has been generated and pinned to IPFS.
            </p>
            {ipfsCid && (
              <p style={{ color: '#475569', fontSize: 12, fontFamily: 'monospace', marginBottom: 24 }}>
                CID: {ipfsCid}
              </p>
            )}
            <a href={`/marketplace?project=${project?.id}`}
              style={{ ...S.btnP, display: 'inline-block', textDecoration: 'none', fontSize: 14 }}>
              Launch on Marketplace →
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
