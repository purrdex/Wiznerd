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
  btnP:   { padding: '11px 24px', background: '#6c47ff', border: 'none', borderRadius: 8, color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
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

  // Step 2 — layer upload
  const [newLayerName, setNewLayerName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingLayer, setUploadingLayer] = useState(false);

  // Generation poll ref
  const genPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (genPollRef.current) clearInterval(genPollRef.current); }, []);

  // Auto-set incompat selects when layers load
  useEffect(() => {
    const first = layers.flatMap(l => l.variants)[0];
    if (first && !incompatA) { setIncompatA(first.id); setIncompatB(first.id); }
  }, [layers, incompatA]);

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
    if (!newLayerName || !project) return;
    const files = fileInputRef.current?.files;
    if (!files || files.length === 0) { setError('Select at least one PNG file'); return; }
    setUploadingLayer(true); setError('');
    try {
      const formData = new FormData();
      formData.append('layer_name', newLayerName);
      formData.append('z_index', String(layers.length));
      for (const f of files) formData.append('files', f);
      const res = await fetch(`${API_URL}/api/projects/${project.id}/layers`, {
        method: 'POST', body: formData, signal: AbortSignal.timeout(60000),
      });
      const data = await res.json() as { layer: Layer; variants: Variant[] };
      if (!res.ok) throw new Error((data as unknown as { error: string }).error);
      setLayers(prev => [...prev, { ...data.layer, variants: data.variants }]);
      setNewLayerName('');
      if (fileInputRef.current) fileInputRef.current.value = '';
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
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700, color: '#fff' }}>🎨 Generative Art Studio</h1>
        <p style={{ margin: '6px 0 0', color: '#64748b', fontSize: 13 }}>Create, configure, and launch your Chia NFT collection</p>
        <div style={{ display: 'flex', gap: 4, marginTop: 18 }}>
          {STEPS.map((label, i) => (
            <div key={i} style={{ flex: 1 }}>
              <div style={{ height: 4, borderRadius: 2, marginBottom: 4,
                background: step > i + 1 ? '#6c47ff' : step === i + 1 ? '#a78bfa' : '#1e2030' }} />
              <span style={{ fontSize: 9, color: step === i + 1 ? '#a78bfa' : '#334155', display: 'block', textAlign: 'center' }}>
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
            <h2 style={{ margin: '0 0 6px', fontSize: 18 }}>Upload Layers</h2>
            <p style={{ margin: '0 0 18px', fontSize: 13, color: '#64748b' }}>
              Each layer is a trait category (Background, Eyes, Hat…). Upload PNG files — one per variant.
            </p>

            {layers.length > 0 && (
              <div style={{ marginBottom: 18 }}>
                {layers.map((layer, idx) => (
                  <div key={layer.id} style={{ background: '#0f1016', border: '1px solid #1e2030', borderRadius: 8, padding: '10px 14px', marginBottom: 6 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>
                      Layer {idx + 1} — {layer.name}
                    </div>
                    <div style={{ fontSize: 12, color: '#475569', marginTop: 2 }}>
                      {layer.variants.length} variant{layer.variants.length !== 1 ? 's' : ''}: {layer.variants.map(v => v.name).join(', ')}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div style={{ border: '1px dashed #2d2f3d', borderRadius: 8, padding: 16, marginBottom: 12 }}>
              <input style={{ ...S.input, marginBottom: 10 }}
                placeholder="Layer name (e.g. Background)"
                value={newLayerName}
                onChange={e => setNewLayerName(e.target.value)} />
              <input ref={fileInputRef} type="file" accept="image/png" multiple
                style={{ display: 'block', marginBottom: 10, fontSize: 12, color: '#64748b' }} />
              <button style={S.btnS} onClick={handleAddLayer} disabled={uploadingLayer || !newLayerName}>
                {uploadingLayer ? 'Uploading…' : '+ Add Layer'}
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
              Set rarity weights (higher = more common) and mark incompatible variant pairs.
            </p>

            {layers.map(layer => {
              const total = layer.variants.reduce((s, v) => s + (v.weight || 100), 0);
              return (
                <div key={layer.id} style={{ marginBottom: 22 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#a78bfa', marginBottom: 10 }}>{layer.name}</div>
                  {layer.variants.map(variant => (
                    <div key={variant.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <span style={{ flex: 1, fontSize: 13, color: '#94a3b8' }}>{variant.name}</span>
                      <span style={S.label}>Wt</span>
                      <input type="number" min={1} max={1000} value={variant.weight}
                        onChange={e => setLayers(prev => prev.map(l => l.id === layer.id ? {
                          ...l, variants: l.variants.map(v => v.id === variant.id ? { ...v, weight: Math.max(1, +e.target.value) } : v),
                        } : l))}
                        style={{ width: 68, padding: '6px 8px', background: '#0f1016', border: '1px solid #2d2f3d', borderRadius: 6, color: '#e2e8f0', fontSize: 13 }}
                      />
                      <span style={{ fontSize: 11, color: '#475569', width: 36, textAlign: 'right' }}>
                        {Math.round(variant.weight / total * 100)}%
                      </span>
                    </div>
                  ))}
                </div>
              );
            })}

            {/* Incompatibilities */}
            <div style={{ borderTop: '1px solid #1e2030', paddingTop: 16, marginTop: 4 }}>
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
                    <span style={{ color: '#a78bfa', fontWeight: 600 }}>{genProgress}%</span>
                  </div>
                  <div style={{ height: 8, background: '#0f1016', borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{ height: '100%', borderRadius: 4, transition: 'width 0.5s ease',
                      width: `${genProgress}%`, background: 'linear-gradient(90deg, #6c47ff, #a78bfa)' }} />
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
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#a78bfa', marginBottom: 10 }}>{layerName}</div>
                    <ResponsiveContainer width="100%" height={150}>
                      <BarChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e2030" />
                        <XAxis dataKey="name" tick={{ fill: '#475569', fontSize: 11 }} />
                        <YAxis tick={{ fill: '#475569', fontSize: 11 }} />
                        <Tooltip
                          contentStyle={{ background: '#161720', border: '1px solid #2d2f3d', borderRadius: 6, fontSize: 12 }}
                          labelStyle={{ color: '#e2e8f0' }}
                        />
                        <Bar dataKey="count" fill="#6c47ff" radius={[4, 4, 0, 0]} />
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
              <div style={{ background: 'rgba(108,71,255,0.08)', border: '1px solid rgba(108,71,255,0.3)', borderRadius: 8, padding: '12px 16px', marginBottom: 16 }}>
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>IPFS CID</div>
                <div style={{ fontSize: 13, fontFamily: 'monospace', color: '#a78bfa', wordBreak: 'break-all' }}>{ipfsCid}</div>
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
