import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import './create.css';
import TopNav from '../components/TopNav';
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
  current_step?: number; creator_address?: string;
  description?: string; collection_image_url?: string; collection_image_path?: string;
}
interface ProjectSummary {
  id: string; name: string; symbol: string; total_supply: number;
  status: string; current_step: number; created_at: string;
  description?: string;
}
interface DidProfile { name: string; description: string; website: string; twitter: string; logo: string; }
type IpfsPhase = 'images' | 'metadata' | 'complete' | 'error';
interface IpfsProgressState {
  phase: IpfsPhase | null;
  imagesDone: number;
  metaDone: number;
  total: number;
  currentFile: string | null;
  error: string | null;
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
  label:  { fontSize: 12, color: '#9ca3af', display: 'block', marginBottom: 4 },
  err:    { background: 'rgba(220,50,50,0.1)', border: '1px solid rgba(220,50,50,0.3)', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#f87171' },
};

const STEPS = ['Project', 'Layers', 'Traits', 'Preview', 'Generate', 'Rarity', 'IPFS', 'Launch'];

// ─── Combination math ─────────────────────────────────────────────────────────
function calcMaxCombinations(layers: Layer[]): number {
  if (layers.length === 0) return 0;
  return layers.reduce((acc, l) => acc * Math.max(1, l.variants.length), 1);
}

function estimateCombinations(layers: Layer[], incompats: { a: string; b: string }[]): number {
  const total = calcMaxCombinations(layers);
  if (incompats.length === 0 || total === 0) return total;
  let blocked = 0;
  for (const rule of incompats) {
    const layerA = layers.find(l => l.variants.some(v => v.id === rule.a));
    const layerB = layers.find(l => l.variants.some(v => v.id === rule.b));
    if (layerA && layerB && layerA.id !== layerB.id
        && layerA.variants.length > 0 && layerB.variants.length > 0) {
      blocked += total / layerA.variants.length / layerB.variants.length;
    }
  }
  return Math.max(0, Math.round(total - blocked));
}

function statusLabel(status: string, step: number): string {
  if (status === 'pinned') return 'Launched';
  if (status === 'complete') return 'Generated';
  if (status === 'generating') return 'Generating…';
  if (status === 'error') return 'Error';
  if (step >= 5) return 'Generating';
  if (step >= 4) return 'Preview';
  if (step >= 3) return 'Traits';
  if (step >= 2) return 'Layers';
  return 'Draft';
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function CreateScreen() {
  const navigate = useNavigate();
  const creatorAddress = (() => {
    try { return localStorage.getItem('chia_primary_address') || ''; } catch { return ''; }
  })();

  // ── Navigation ──────────────────────────────────────────────────────────────
  const [showDashboard, setShowDashboard] = useState(true);
  const [step, setStep] = useState(1);
  const [saveIndicator, setSaveIndicator] = useState(false);

  // ── Dashboard ───────────────────────────────────────────────────────────────
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);

  // ── Project / wizard state ───────────────────────────────────────────────────
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
  const [ipfsService, setIpfsService] = useState('');
  const [ipfsTestStatus, setIpfsTestStatus] = useState<{ ok: boolean; service?: string | null; error?: string } | null>(null);
  const [ipfsTestBusy, setIpfsTestBusy] = useState(false);
  const [ipfsProgress, setIpfsProgress] = useState<IpfsProgressState>({ phase: null, imagesDone: 0, metaDone: 0, total: 0, currentFile: null, error: null });
  const [ipfsSpeedText, setIpfsSpeedText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Step 8 — launch / marketplace publish
  const [mintPriceXch, setMintPriceXch] = useState('');
  const [launchImmediate, setLaunchImmediate] = useState(true);
  const [launchAt, setLaunchAt] = useState('');
  const [allowlistText, setAllowlistText] = useState('');
  const [revealType, setRevealType] = useState<'instant' | 'blind'>('instant');
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishError, setPublishError] = useState('');

  // Step 1 fields
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [description, setDescription] = useState('');
  const [supply, setSupply] = useState(100);
  const [royalty, setRoyalty] = useState(5);
  const [collectionImageFile, setCollectionImageFile] = useState<File | null>(null);
  const [collectionImagePreview, setCollectionImagePreview] = useState('');
  const collectionImageInputRef = useRef<HTMLInputElement>(null);

  // DID profile (platform-level, in dashboard)
  const [didProfile, setDidProfile] = useState<DidProfile>({ name: '', description: '', website: '', twitter: '', logo: '' });
  const [didProfileOpen, setDidProfileOpen] = useState(false);
  const [didProfileBusy, setDidProfileBusy] = useState(false);
  const [didProfileMsg, setDidProfileMsg] = useState('');

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
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next;
  });

  // Generation poll ref
  const genPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (genPollRef.current) clearInterval(genPollRef.current); }, []);

  // IPFS speed-tracking refs
  const ipfsUploadLogRef = useRef<{ total: number; time: number }[]>([]);
  const ipfsStartTimeRef = useRef<number | null>(null);

  // ── Background fix ──────────────────────────────────────────────────────────
  useEffect(() => {
    const prev = document.body.style.background;
    document.body.style.background = '#0a0b0f';
    document.documentElement.style.background = '#0a0b0f';
    return () => { document.body.style.background = prev; document.documentElement.style.background = ''; };
  }, []);

  // ── Load user's projects on mount ───────────────────────────────────────────
  const loadProjects = useCallback(async () => {
    if (!creatorAddress) return;
    setLoadingProjects(true);
    try {
      const res = await fetch(`${API_URL}/api/projects?creator_address=${encodeURIComponent(creatorAddress)}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) setProjects(await res.json() as ProjectSummary[]);
    } catch { /* silent */ }
    finally { setLoadingProjects(false); }
  }, [creatorAddress]);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  // Auto-set incompat selects; auto-expand on step 3
  useEffect(() => {
    const first = layers.flatMap(l => l.variants)[0];
    if (first && !incompatA) { setIncompatA(first.id); setIncompatB(first.id); }
  }, [layers, incompatA]);

  useEffect(() => {
    if (step === 3) setExpandedLayers(new Set(layers.map(l => l.id)));
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // Rarity data on step 6
  useEffect(() => {
    if (step !== 6 || !project) return;
    fetch(`${API_URL}/api/projects/${project.id}/rarity`, { signal: AbortSignal.timeout(10000) })
      .then(r => r.json())
      .then(d => setRarityData(d as Record<string, Record<string, number>>))
      .catch(() => {});
  }, [step, project]);

  // Realtime subscription on step 5
  useEffect(() => {
    if (step !== 5 || !project) return;
    const channel = supabase
      .channel(`project-${project.id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'projects', filter: `id=eq.${project.id}` }, payload => {
        const p = payload.new as { generation_progress: number; status: string };
        setGenProgress(p.generation_progress ?? 0);
        if (p.status === 'complete') {
          setGenStatus('Complete!'); setBusy(false);
          if (genPollRef.current) { clearInterval(genPollRef.current); genPollRef.current = null; }
        } else if (p.status === 'error') {
          setGenStatus('Error'); setError('Generation failed — check server logs'); setBusy(false);
        }
      }).subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [step, project]);

  // IPFS progress: load persisted state + live Realtime updates on step 7
  useEffect(() => {
    if (step !== 7 || !project) return;

    // Load current state (handles page refresh mid-upload or after completion)
    fetch(`${API_URL}/api/projects/${project.id}`, { signal: AbortSignal.timeout(5000) })
      .then(r => r.json())
      .then((p: Record<string, unknown>) => {
        const phase = p.ipfs_phase as IpfsPhase | undefined;
        if (phase) {
          setIpfsProgress({
            phase,
            imagesDone: (p.ipfs_images_done as number) || 0,
            metaDone: (p.ipfs_meta_done as number) || 0,
            total: (p.ipfs_total as number) || 0,
            currentFile: (p.ipfs_current_file as string | null) || null,
            error: (p.ipfs_error as string | null) || null,
          });
        }
        if (p.ipfs_cid) setIpfsCid(p.ipfs_cid as string);
        if (p.ipfs_service) setIpfsService(p.ipfs_service as string);
      }).catch(() => {});

    ipfsUploadLogRef.current = [];
    ipfsStartTimeRef.current = null;

    const channel = supabase.channel(`ipfs-progress-${project.id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'projects', filter: `id=eq.${project.id}` }, payload => {
        const p = payload.new as Record<string, unknown>;
        const phase = p.ipfs_phase as IpfsPhase | undefined;
        if (!phase) return;

        const imagesDone = (p.ipfs_images_done as number) || 0;
        const metaDone = (p.ipfs_meta_done as number) || 0;
        const total = (p.ipfs_total as number) || 0;

        setIpfsProgress({
          phase,
          imagesDone,
          metaDone,
          total,
          currentFile: (p.ipfs_current_file as string | null) || null,
          error: (p.ipfs_error as string | null) || null,
        });

        // Speed calculation: track total files uploaded across both phases
        const totalDone = (phase === 'metadata' || phase === 'complete' ? total : 0) +
                          (phase === 'images' ? imagesDone : metaDone);
        const now = Date.now();
        if (!ipfsStartTimeRef.current && totalDone > 0) ipfsStartTimeRef.current = now;
        const log = ipfsUploadLogRef.current;
        log.push({ total: totalDone, time: now });
        if (log.length > 10) log.shift();
        if (log.length >= 2) {
          const oldest = log[0];
          const newest = log[log.length - 1];
          const elapsed = (newest.time - oldest.time) / 1000;
          if (elapsed > 0) {
            const rate = (newest.total - oldest.total) / elapsed;
            const grandTotal = total * 2;
            const remaining = grandTotal - totalDone;
            const eta = rate > 0 ? remaining / rate : null;
            const rateStr = rate >= 1 ? `${rate.toFixed(1)} files/sec` : `${(rate * 60).toFixed(1)} files/min`;
            const etaStr = eta !== null
              ? (eta > 60 ? `~${Math.ceil(eta / 60)} min remaining` : `~${Math.ceil(eta)} sec remaining`)
              : '';
            setIpfsSpeedText(etaStr ? `${rateStr} — ${etaStr}` : rateStr);
          }
        }

        if (phase === 'complete') {
          setBusy(false);
          if (p.ipfs_cid) setIpfsCid(p.ipfs_cid as string);
          if (p.ipfs_service) setIpfsService(p.ipfs_service as string);
        } else if (phase === 'error') {
          setBusy(false);
        }
      }).subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [step, project]);

  // ─── Auto-save helper ────────────────────────────────────────────────────────
  async function advanceStep(nextStep: number) {
    setStep(nextStep);
    if (project) {
      setSaveIndicator(true);
      setTimeout(() => setSaveIndicator(false), 2000);
      fetch(`${API_URL}/api/projects/${project.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_step: nextStep }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }
  }

  // ─── Dashboard handlers ──────────────────────────────────────────────────────
  async function handleResumeProject(proj: ProjectSummary) {
    setError(''); setBusy(true);
    try {
      const [projectRes, layersRes, incompatRes] = await Promise.all([
        fetch(`${API_URL}/api/projects/${proj.id}`, { signal: AbortSignal.timeout(10000) }),
        fetch(`${API_URL}/api/projects/${proj.id}/layers`, { signal: AbortSignal.timeout(10000) }),
        fetch(`${API_URL}/api/projects/${proj.id}/incompatibilities`, { signal: AbortSignal.timeout(10000) }),
      ]);
      const projectData = await projectRes.json() as Project;
      const layersData = await layersRes.json() as Layer[];
      const incompatData = await incompatRes.json() as { variant_a: string; variant_b: string }[];
      setProject(projectData);
      setDescription(projectData.description || '');
      setLayers(layersData || []);
      setIncompats((incompatData || []).map(r => ({ a: r.variant_a, b: r.variant_b })));
      setStep(Math.max(1, proj.current_step || 1));
      setShowDashboard(false);
    } catch (e: unknown) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function handleDeleteProject(id: string) {
    if (!window.confirm('Delete this project and all its data? This cannot be undone.')) return;
    try {
      await fetch(`${API_URL}/api/projects/${id}`, { method: 'DELETE', signal: AbortSignal.timeout(15000) });
      setProjects(prev => prev.filter(p => p.id !== id));
    } catch (e: unknown) { setError((e as Error).message); }
  }

  async function handleSaveDidProfile() {
    setDidProfileBusy(true); setDidProfileMsg('');
    try {
      const res = await fetch(`${API_URL}/api/admin/did-profile`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(didProfile),
        signal: AbortSignal.timeout(90000),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Update failed');
      setDidProfileMsg('Submitted to blockchain — changes visible once confirmed (1-2 min)');
    } catch (e: unknown) { setDidProfileMsg((e as Error).message); }
    finally { setDidProfileBusy(false); }
  }

  // ─── Wizard handlers ─────────────────────────────────────────────────────────
  async function handleCreateProject() {
    if (!name || !symbol || !description) return;
    setBusy(true); setError('');
    try {
      const res = await fetch(`${API_URL}/api/projects`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, symbol, description, total_supply: supply, royalty_percent: royalty, creator_address: creatorAddress, current_step: 2 }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json() as Project & { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Create failed');
      if (collectionImageFile) {
        const fd = new FormData();
        fd.append('image', collectionImageFile);
        await fetch(`${API_URL}/api/projects/${data.id}/collection-image`, {
          method: 'POST', body: fd, signal: AbortSignal.timeout(30000),
        });
      }
      setProject(data);
      setStep(2);
      setShowDashboard(false);
      await loadProjects();
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
      const res = await fetch(`${API_URL}/api/projects/${project.id}/layers/${layerId}`, { method: 'DELETE', signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error('Delete failed');
      setLayers(prev => prev.filter(l => l.id !== layerId).map((l, i) => ({ ...l, z_index: i })));
    } catch (e: unknown) { setError((e as Error).message); }
  }

  async function handleSaveLayerName(layerId: string) {
    if (!project || !editLayerNameVal.trim()) { setEditingLayerId(null); return; }
    try {
      await fetch(`${API_URL}/api/projects/${project.id}/layers/${layerId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editLayerNameVal.trim() }), signal: AbortSignal.timeout(10000),
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
      fetch(`${API_URL}/api/projects/${project.id}/layers/${next[idx].id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ z_index: idx }), signal: AbortSignal.timeout(5000) }),
      fetch(`${API_URL}/api/projects/${project.id}/layers/${next[newIdx].id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ z_index: newIdx }), signal: AbortSignal.timeout(5000) }),
    ]);
  }

  async function handleDeleteVariant(layerId: string, variantId: string) {
    if (!project) return;
    try {
      await fetch(`${API_URL}/api/projects/${project.id}/variants/${variantId}`, { method: 'DELETE', signal: AbortSignal.timeout(10000) });
      setLayers(prev => prev.map(l => l.id === layerId ? { ...l, variants: l.variants.filter(v => v.id !== variantId) } : l));
    } catch (e: unknown) { setError((e as Error).message); }
  }

  async function handleAddVariants(layerId: string, files: File[]) {
    if (!project || files.length === 0) return;
    setUploadingLayer(true); setError('');
    try {
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      const res = await fetch(`${API_URL}/api/projects/${project.id}/layers/${layerId}/variants`, { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) });
      const data = await res.json() as { variants: Variant[]; errors?: string[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Upload failed');
      setLayers(prev => prev.map(l => l.id === layerId ? { ...l, variants: [...l.variants, ...data.variants] } : l));
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
      await advanceStep(4);
    } catch (e: unknown) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function handlePreview() {
    if (calcMaxCombinations(layers) === 0) { setError('Add at least one layer with variants before previewing'); return; }
    if (!project) return;
    setBusy(true); setError(''); setPreviews([]);
    try {
      const res = await fetch(`${API_URL}/api/projects/${project.id}/preview`, { method: 'POST', signal: AbortSignal.timeout(120000) });
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
      const res = await fetch(`${API_URL}/api/projects/${project.id}/generate`, { method: 'POST', signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error((await res.json() as { error: string }).error);
      setGenStatus('Generating…');
      genPollRef.current = setInterval(async () => {
        try {
          const r = await fetch(`${API_URL}/api/projects/${project.id}/status`, { signal: AbortSignal.timeout(5000) });
          const d = await r.json() as { status: string; progress: number };
          setGenProgress(d.progress ?? 0);
          if (d.status === 'complete') { clearInterval(genPollRef.current!); genPollRef.current = null; setGenStatus('Complete!'); setBusy(false); }
          else if (d.status === 'error') { clearInterval(genPollRef.current!); genPollRef.current = null; setError('Generation failed'); setBusy(false); }
        } catch { /* transient */ }
      }, 3000);
    } catch (e: unknown) { setError((e as Error).message); setBusy(false); }
  }

  async function handlePublish() {
    if (!project) return;
    const price = parseFloat(mintPriceXch);
    if (isNaN(price) || price < 0) { setPublishError('Enter a valid mint price (0 for free)'); return; }
    if (!launchImmediate && !launchAt) { setPublishError('Select a launch date or choose "Launch immediately"'); return; }
    setPublishBusy(true); setPublishError('');
    try {
      const mint_price_mojo = Math.round(price * 1e12);
      const allowlist = allowlistText.split('\n').map(s => s.trim()).filter(s => s.startsWith('xch1'));
      const res = await fetch(`${API_URL}/api/projects/${project.id}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mint_price_mojo,
          launch_at: launchImmediate ? null : launchAt,
          allowlist,
          reveal_type: revealType,
        }),
        signal: AbortSignal.timeout(10000),
      });
      const json = await res.json().catch(() => ({ success: false, error: 'Server returned non-JSON response' }));
      if (!res.ok || !json.success) throw new Error(json.error || 'Publish failed');
      navigate(`/marketplace/${project.id}`);
    } catch (e: unknown) {
      setPublishError(e instanceof Error ? e.message : String(e));
      setPublishBusy(false);
    }
  }

  async function handleTestIPFS() {
    setIpfsTestBusy(true); setIpfsTestStatus(null);
    try {
      const res = await fetch(`${API_URL}/api/ipfs/test`, { signal: AbortSignal.timeout(30000) });
      setIpfsTestStatus(await res.json() as { ok: boolean; service?: string; error?: string });
    } catch (e: unknown) { setIpfsTestStatus({ ok: false, error: (e as Error).message }); }
    finally { setIpfsTestBusy(false); }
  }

  async function handleIpfsPin() {
    if (!project) return;
    setBusy(true); setError('');
    setIpfsProgress({ phase: 'images', imagesDone: 0, metaDone: 0, total: 0, currentFile: null, error: null });
    setIpfsSpeedText('');
    ipfsUploadLogRef.current = [];
    ipfsStartTimeRef.current = null;
    try {
      const res = await fetch(`${API_URL}/api/projects/${project.id}/ipfs`, { method: 'POST', signal: AbortSignal.timeout(300000) });
      const data = await res.json() as { cid?: string; service?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'IPFS pin failed');
      // Realtime handles the progress + completion state; sync fallback in case Realtime is slow
      if (data.service) setIpfsService(data.service);
      if (data.cid) {
        setIpfsCid(data.cid);
        setIpfsProgress(prev => prev.phase !== 'complete' && prev.phase !== 'error'
          ? { ...prev, phase: 'complete' } : prev);
      }
    } catch (e: unknown) {
      const msg = (e as Error).message;
      setError(msg);
      setIpfsProgress(prev => ({ ...prev, phase: 'error', error: msg }));
    }
    finally { setBusy(false); }
  }

  // ─── Derived values ──────────────────────────────────────────────────────────
  const allVariants = layers.flatMap(l => l.variants.map(v => ({ ...v, layerName: l.name })));
  const maxCombinations = calcMaxCombinations(layers);
  const estimatedCombinations = estimateCombinations(layers, incompats);
  const supplyFeasible = estimatedCombinations >= (project?.total_supply ?? 0);
  const saturation = maxCombinations > 0 ? (project?.total_supply ?? 0) / maxCombinations : 0;

  // ─── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={{ ...S.page, padding: 0 }} className="create-page">
      <TopNav />
      <div style={{ padding: 24 }}>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ maxWidth: 720, margin: '0 auto 28px' }}>
        <div style={{ textAlign: 'center', paddingTop: 8 }}>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: '#fff' }}>Art Studio</h1>
            <p style={{ margin: '4px 0 0', color: '#94a3b8', fontSize: 13 }}>Create, configure, and launch your Chia NFT collection</p>
        </div>

        {!showDashboard && (
          <>
            <div style={{ display: 'flex', gap: 4, marginTop: 18 }}>
              {STEPS.map((label, i) => (
                <div key={i} style={{ flex: 1 }}>
                  <div style={{ height: 4, borderRadius: 2, marginBottom: 4,
                    background: step > i + 1 ? '#f97316' : step === i + 1 ? '#fb923c' : '#1e2030' }} />
                  <span style={{ fontSize: 9, color: step === i + 1 ? '#fb923c' : '#6b7280', display: 'block', textAlign: 'center' }}>{label}</span>
                </div>
              ))}
            </div>
            {saveIndicator && (
              <div style={{ textAlign: 'center', marginTop: 6, fontSize: 11, color: '#4ade80' }}>✓ Progress saved</div>
            )}
          </>
        )}
      </div>

      {/* ── Dashboard ──────────────────────────────────────────────────────── */}
      {showDashboard && (
        <div style={{ maxWidth: 720, margin: '0 auto' }}>
          {!creatorAddress && (
            <div style={{ ...S.card, marginBottom: 16, textAlign: 'center', padding: 16, fontSize: 13, color: '#94a3b8' }}>
              Open the wallet first — your wallet address is used to identify your projects.
            </div>
          )}

          {creatorAddress && (
            <div style={{ ...S.card, marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                <h2 style={{ margin: 0, fontSize: 16 }}>My Projects</h2>
                <span style={{ fontSize: 11, color: '#f97316', fontFamily: 'monospace' }}>{creatorAddress.slice(0, 20)}…</span>
              </div>
              {loadingProjects ? (
                <div style={{ fontSize: 13, color: '#94a3b8' }}>Loading…</div>
              ) : projects.length === 0 ? (
                <div style={{ fontSize: 13, color: '#94a3b8' }}>No projects yet — create your first one below.</div>
              ) : (
                <div>
                  {projects.map(proj => (
                    <div key={proj.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: '#0f1016', borderRadius: 8, marginBottom: 6 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>
                          {proj.name}
                          <span style={{ fontSize: 10, color: '#6b7280', marginLeft: 6 }}>{proj.symbol}</span>
                        </div>
                        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
                          Supply: {proj.total_supply} · {statusLabel(proj.status, proj.current_step)}
                          <span style={{ marginLeft: 8 }}>{new Date(proj.created_at).toLocaleDateString()}</span>
                        </div>
                      </div>
                      <button style={{ ...S.btnP, padding: '6px 14px', fontSize: 12 }} onClick={() => handleResumeProject(proj)} disabled={busy}>
                        {busy ? '…' : 'Continue'}
                      </button>
                      <button onClick={() => handleDeleteProject(proj.id)}
                        style={{ ...S.btnS, padding: '6px 12px', fontSize: 12, color: '#f87171', borderColor: 'rgba(248,113,113,0.3)' }}>
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* New project */}
          <div style={S.card}>
            {error && <div style={S.err}>{error}</div>}
            <h2 style={{ margin: '0 0 18px', fontSize: 18 }}>New Project</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <span style={S.label}>Collection name</span>
                <input style={S.input} placeholder="e.g. Wiznerd Wizards" value={name} onChange={e => setName(e.target.value)} />
              </div>
              <div>
                <span style={S.label}>Symbol</span>
                <input style={S.input} placeholder="e.g. WZNRD" value={symbol} maxLength={8} onChange={e => setSymbol(e.target.value.toUpperCase())} />
              </div>
              <div>
                <span style={S.label}>Description <span style={{ color: '#6b7280' }}>(shown on MintGarden, SpaceScan)</span></span>
                <textarea
                  style={{ ...S.input, resize: 'vertical', minHeight: 72 }}
                  placeholder="Describe your collection — what makes it unique?"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <span style={S.label}>Total supply</span>
                  <input style={S.input} type="number" value={supply} min={1} max={10000} onChange={e => setSupply(Math.max(1, Math.min(10000, +e.target.value)))} />
                </div>
                <div>
                  <span style={S.label}>Royalty %</span>
                  <input style={S.input} type="number" value={royalty} min={0} max={15} onChange={e => setRoyalty(Math.max(0, Math.min(15, +e.target.value)))} />
                </div>
              </div>
              <div>
                <span style={S.label}>Collection image <span style={{ color: '#6b7280' }}>(optional)</span></span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  {collectionImagePreview && (
                    <img src={collectionImagePreview} alt="collection" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8, border: '1px solid #2d2f3d', flexShrink: 0 }} />
                  )}
                  <button style={{ ...S.btnS, fontSize: 12 }} onClick={() => collectionImageInputRef.current?.click()}>
                    {collectionImagePreview ? 'Change image' : 'Upload image'}
                  </button>
                  {collectionImagePreview && (
                    <button style={{ ...S.btnS, fontSize: 12 }} onClick={() => { setCollectionImageFile(null); setCollectionImagePreview(''); }}>Remove</button>
                  )}
                </div>
              </div>
              <button style={{ ...S.btnP, marginTop: 4 }} onClick={handleCreateProject} disabled={busy || !name || !symbol || !description}>
                {busy ? 'Creating…' : 'Create Project →'}
              </button>
            </div>
          </div>

          {/* DID profile */}
          <div style={{ ...S.card, marginTop: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }} onClick={() => setDidProfileOpen(o => !o)}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 600 }}>Platform Profile (DID)</div>
                <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>Name, bio, links shown on MintGarden and SpaceScan next to "Minted by"</div>
              </div>
              <span style={{ color: '#9ca3af', fontSize: 18 }}>{didProfileOpen ? '▲' : '▼'}</span>
            </div>
            {didProfileOpen && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <span style={S.label}>Platform name</span>
                    <input style={S.input} placeholder="e.g. Wiznerd" value={didProfile.name} onChange={e => setDidProfile(p => ({ ...p, name: e.target.value }))} />
                  </div>
                  <div>
                    <span style={S.label}>Twitter handle</span>
                    <input style={S.input} placeholder="@wiznerd" value={didProfile.twitter} onChange={e => setDidProfile(p => ({ ...p, twitter: e.target.value }))} />
                  </div>
                </div>
                <div>
                  <span style={S.label}>Description / bio</span>
                  <textarea style={{ ...S.input, resize: 'vertical', minHeight: 60 }} placeholder="What is your platform?" value={didProfile.description} onChange={e => setDidProfile(p => ({ ...p, description: e.target.value }))} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <span style={S.label}>Website URL</span>
                    <input style={S.input} placeholder="https://wiznerd.io" value={didProfile.website} onChange={e => setDidProfile(p => ({ ...p, website: e.target.value }))} />
                  </div>
                  <div>
                    <span style={S.label}>Logo (IPFS URL)</span>
                    <input style={S.input} placeholder="ipfs://..." value={didProfile.logo} onChange={e => setDidProfile(p => ({ ...p, logo: e.target.value }))} />
                  </div>
                </div>
                <div style={{ fontSize: 12, color: '#9ca3af', background: 'rgba(249,115,22,0.08)', border: '1px solid rgba(249,115,22,0.2)', borderRadius: 6, padding: '8px 12px' }}>
                  This writes metadata on-chain to your minting DID — costs a small XCH fee and takes 1-2 min to confirm.
                </div>
                {didProfileMsg && (
                  <div style={{ fontSize: 13, color: didProfileMsg.includes('Submitted') ? '#4ade80' : '#f87171' }}>{didProfileMsg}</div>
                )}
                <button style={{ ...S.btnP, alignSelf: 'flex-start' }} onClick={handleSaveDidProfile} disabled={didProfileBusy}>
                  {didProfileBusy ? 'Submitting…' : 'Save to Blockchain'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Wizard ─────────────────────────────────────────────────────────── */}
      {!showDashboard && (
        <div style={S.card}>
          {error && <div style={S.err}>{error}</div>}

          {/* ── Step 1: Project ────────────────────────────────────────────── */}
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
                  <input style={S.input} placeholder="e.g. WZNRD" value={symbol} maxLength={8} onChange={e => setSymbol(e.target.value.toUpperCase())} />
                </div>
                <div>
                  <span style={S.label}>Description <span style={{ color: '#6b7280' }}>(shown on MintGarden, SpaceScan)</span></span>
                  <textarea
                    style={{ ...S.input, resize: 'vertical', minHeight: 72 }}
                    placeholder="Describe your collection — what makes it unique?"
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                  />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <span style={S.label}>Total supply</span>
                    <input style={S.input} type="number" value={supply} min={1} max={10000} onChange={e => setSupply(Math.max(1, Math.min(10000, +e.target.value)))} />
                  </div>
                  <div>
                    <span style={S.label}>Royalty %</span>
                    <input style={S.input} type="number" value={royalty} min={0} max={15} onChange={e => setRoyalty(Math.max(0, Math.min(15, +e.target.value)))} />
                  </div>
                </div>
                <div>
                  <span style={S.label}>Collection image <span style={{ color: '#6b7280' }}>(optional — thumbnail shown on explorers)</span></span>
                  <input ref={collectionImageInputRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }}
                    onChange={e => {
                      const f = e.target.files?.[0] ?? null;
                      setCollectionImageFile(f);
                      setCollectionImagePreview(f ? URL.createObjectURL(f) : '');
                      e.target.value = '';
                    }} />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    {collectionImagePreview && (
                      <img src={collectionImagePreview} alt="collection" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8, border: '1px solid #2d2f3d', flexShrink: 0 }} />
                    )}
                    <button style={{ ...S.btnS, fontSize: 12 }} onClick={() => collectionImageInputRef.current?.click()}>
                      {collectionImagePreview ? 'Change image' : 'Upload image'}
                    </button>
                    {collectionImagePreview && (
                      <button style={{ ...S.btnS, fontSize: 12 }} onClick={() => { setCollectionImageFile(null); setCollectionImagePreview(''); }}>Remove</button>
                    )}
                  </div>
                </div>
                <button style={{ ...S.btnP, marginTop: 4 }} onClick={handleCreateProject} disabled={busy || !name || !symbol || !description}>
                  {busy ? 'Creating…' : 'Create Project →'}
                </button>
              </div>
              <div style={{ marginTop: 16, textAlign: 'center' }}>
                <button style={{ ...S.btnS, border: 'none', fontSize: 12 }} onClick={() => setShowDashboard(true)}>← Back to My Projects</button>
              </div>
            </div>
          )}

          {/* ── Step 2: Layer Upload ────────────────────────────────────────── */}
          {step === 2 && (
            <div>
              <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>Upload Layers</h2>
              <p style={{ margin: '0 0 18px', fontSize: 13, color: '#94a3b8' }}>
                Layers stack bottom-to-top (z=0 = Background, highest = foreground accessories). Each PNG = one variant.
              </p>

              <input ref={newLayerFileInputRef} type="file" accept="image/png" multiple style={{ display: 'none' }}
                onChange={e => { if (e.target.files) { setPendingFiles(prev => [...prev, ...Array.from(e.target.files!)]); e.target.value = ''; } }} />
              <input ref={addVariantFileInputRef} type="file" accept="image/png" multiple style={{ display: 'none' }}
                onChange={e => { if (e.target.files && addVariantTargetId) { handleAddVariants(addVariantTargetId, Array.from(e.target.files)); e.target.value = ''; } }} />

              {layers.length > 0 && (
                <div style={{ marginBottom: 20 }}>
                  {layers.map((layer, idx) => {
                    const isExp = expandedInStep2.has(layer.id);
                    const isEd = editingLayerId === layer.id;
                    return (
                      <div key={layer.id} style={{ border: '1px solid #1e2030', borderRadius: 8, marginBottom: 8, overflow: 'hidden' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: '#0f1016' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 }}>
                            <button onClick={() => handleMoveLayer(layer.id, -1)} disabled={idx === 0}
                              style={{ ...S.btnS, padding: '1px 5px', fontSize: 9, lineHeight: 1.2, opacity: idx === 0 ? 0.3 : 1 }}>▲</button>
                            <button onClick={() => handleMoveLayer(layer.id, 1)} disabled={idx === layers.length - 1}
                              style={{ ...S.btnS, padding: '1px 5px', fontSize: 9, lineHeight: 1.2, opacity: idx === layers.length - 1 ? 0.3 : 1 }}>▼</button>
                          </div>
                          <span style={{ fontSize: 10, color: '#6b7280', background: '#1e2030', borderRadius: 4, padding: '2px 5px', flexShrink: 0 }}>{idx + 1}</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            {isEd ? (
                              <input autoFocus value={editLayerNameVal} onChange={e => setEditLayerNameVal(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') handleSaveLayerName(layer.id); if (e.key === 'Escape') setEditingLayerId(null); }}
                                onBlur={() => handleSaveLayerName(layer.id)}
                                style={{ ...S.input, padding: '4px 8px', fontSize: 13 }} />
                            ) : (
                              <span style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>{layer.name}
                                <span style={{ fontWeight: 400, color: '#6b7280', fontSize: 11, marginLeft: 6 }}>({layer.variants.length} variants)</span>
                              </span>
                            )}
                          </div>
                          {!isEd && (
                            <button onClick={() => { setEditingLayerId(layer.id); setEditLayerNameVal(layer.name); }}
                              style={{ ...S.btnS, padding: '3px 9px', fontSize: 11, flexShrink: 0 }}>Rename</button>
                          )}
                          <button onClick={() => handleDeleteLayer(layer.id)}
                            style={{ ...S.btnS, padding: '3px 9px', fontSize: 11, color: '#f87171', borderColor: 'rgba(248,113,113,0.3)', flexShrink: 0 }}>Delete</button>
                          <button onClick={() => setExpandedInStep2(prev => { const n = new Set(prev); n.has(layer.id) ? n.delete(layer.id) : n.add(layer.id); return n; })}
                            style={{ ...S.btnS, padding: '3px 8px', fontSize: 11, flexShrink: 0 }}>{isExp ? '▲' : '▼'}</button>
                        </div>
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
                                    ? { ...l, variants: l.variants.map(vv => vv.id === v.id ? { ...vv, name: e.target.value } : vv) } : l))}
                                  style={{ flex: 1, padding: '4px 8px', background: '#0f1016', border: '1px solid #2d2f3d', borderRadius: 5, color: '#e2e8f0', fontSize: 12 }} />
                                <button onClick={() => handleDeleteVariant(layer.id, v.id)}
                                  style={{ ...S.btnS, padding: '3px 9px', fontSize: 11, color: '#f87171', borderColor: 'rgba(248,113,113,0.3)', flexShrink: 0 }}>Remove</button>
                              </div>
                            ))}
                            <div
                              onDragOver={e => { e.preventDefault(); setDragOverLayerId(layer.id); }}
                              onDragLeave={() => setDragOverLayerId(null)}
                              onDrop={e => { e.preventDefault(); setDragOverLayerId(null); handleAddVariants(layer.id, Array.from(e.dataTransfer.files).filter(f => f.type === 'image/png')); }}
                              onClick={() => { setAddVariantTargetId(layer.id); addVariantFileInputRef.current?.click(); }}
                              style={{
                                border: `1px dashed ${dragOverLayerId === layer.id ? '#f97316' : '#2d2f3d'}`,
                                borderRadius: 6, padding: '10px', textAlign: 'center', cursor: 'pointer',
                                background: dragOverLayerId === layer.id ? 'rgba(249,115,22,0.05)' : 'transparent',
                                marginTop: 6, fontSize: 12, color: '#94a3b8', transition: 'all 0.15s',
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

              <div style={{ border: '1px solid #2d2f3d', borderRadius: 8, padding: 16, background: '#0f1016' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>New Layer</div>
                <input style={{ ...S.input, marginBottom: 10 }} placeholder="Layer name (e.g. Background, Eyes, Hat)"
                  value={newLayerName} onChange={e => setNewLayerName(e.target.value)} />
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
                  <div style={{ fontSize: 13, color: dragOverNew ? '#f97316' : '#94a3b8' }}>Drop PNG files here or click to browse</div>
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 3 }}>Each PNG becomes one variant (red.png, blue.png…)</div>
                </div>
                {pendingFiles.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 12 }}>
                    {pendingFiles.map((f, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', background: '#161720', border: '1px solid #2d2f3d', borderRadius: 5, fontSize: 11, color: '#94a3b8' }}>
                        {f.name}
                        <button onClick={e => { e.stopPropagation(); setPendingFiles(prev => prev.filter((_, j) => j !== i)); }}
                          style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: 0, marginLeft: 2, fontSize: 14, lineHeight: 1 }}>×</button>
                      </div>
                    ))}
                  </div>
                )}
                <button style={{ ...S.btnP, opacity: uploadingLayer || !newLayerName.trim() || pendingFiles.length === 0 ? 0.5 : 1 }}
                  onClick={handleAddLayer} disabled={uploadingLayer || !newLayerName.trim() || pendingFiles.length === 0}>
                  {uploadingLayer ? 'Uploading…' : `+ Add Layer${pendingFiles.length > 0 ? ` (${pendingFiles.length} file${pendingFiles.length !== 1 ? 's' : ''})` : ''}`}
                </button>
              </div>

              <div style={S.row}>
                <button style={S.btnS} onClick={() => setShowDashboard(true)}>← Back</button>
                <button style={S.btnP} onClick={() => { setError(''); advanceStep(3); }} disabled={layers.length === 0}>Configure Traits →</button>
              </div>
            </div>
          )}

          {/* ── Step 3: Trait Config ────────────────────────────────────────── */}
          {step === 3 && (
            <div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
                <h2 style={{ margin: 0, fontSize: 18 }}>Trait Configuration</h2>
                {maxCombinations > 0 && (
                  <span style={{ fontSize: 12, color: '#f97316', fontWeight: 600 }}>
                    ~{estimatedCombinations.toLocaleString()} combinations
                  </span>
                )}
              </div>
              <p style={{ margin: '0 0 18px', fontSize: 13, color: '#94a3b8' }}>
                Click a layer to expand it. Set rarity weights (higher = more common) and mark incompatible variant pairs below.
              </p>

              {layers.map(layer => {
                const isExpanded = expandedLayers.has(layer.id);
                const total = layer.variants.reduce((s, v) => s + (v.weight || 100), 0);
                return (
                  <div key={layer.id} style={{ marginBottom: 8, border: '1px solid #1e2030', borderRadius: 8, overflow: 'hidden' }}>
                    <div onClick={() => toggleLayer(layer.id)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', cursor: 'pointer', background: '#0f1016', userSelect: 'none' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: '#f97316' }}>{layer.name}</span>
                        <span style={{ fontSize: 11, color: '#94a3b8' }}>{layer.variants.length} variant{layer.variants.length !== 1 ? 's' : ''}</span>
                      </div>
                      <span style={{ color: '#94a3b8', fontSize: 11 }}>{isExpanded ? '▲' : '▼'}</span>
                    </div>
                    {isExpanded && (
                      <div style={{ padding: '10px 16px 14px', borderTop: '1px solid #1e2030' }}>
                        {layer.variants.map(variant => (
                          <div key={variant.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, padding: '8px 10px', background: '#0a0b0f', borderRadius: 6 }}>
                            {variant.file_path && (
                              <img src={`${API_URL}/api/thumb?path=${encodeURIComponent(variant.file_path)}`} alt={variant.name}
                                style={{ width: 44, height: 44, borderRadius: 4, objectFit: 'cover', flexShrink: 0, border: '1px solid #1e2030' }} />
                            )}
                            <span style={{ flex: 1, fontSize: 13, color: '#94a3b8' }}>{variant.name}</span>
                            <span style={{ ...S.label, margin: 0 }}>Wt</span>
                            <input type="number" min={1} max={1000} value={variant.weight || 100}
                              onChange={e => setLayers(prev => prev.map(l => l.id === layer.id ? {
                                ...l, variants: l.variants.map(v => v.id === variant.id ? { ...v, weight: Math.max(1, +e.target.value) } : v),
                              } : l))}
                              style={{ width: 68, padding: '6px 8px', background: '#0f1016', border: '1px solid #2d2f3d', borderRadius: 6, color: '#e2e8f0', fontSize: 13 }} />
                            <span style={{ fontSize: 11, color: '#94a3b8', width: 36, textAlign: 'right' }}>
                              {total > 0 ? Math.round((variant.weight || 100) / total * 100) : 0}%
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}

              <div style={{ borderTop: '1px solid #1e2030', paddingTop: 16, marginTop: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Incompatibility Rules</div>
                {incompats.map((rule, i) => {
                  const va = allVariants.find(v => v.id === rule.a);
                  const vb = allVariants.find(v => v.id === rule.b);
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 12 }}>
                      <span style={{ flex: 1, color: '#94a3b8' }}>{va ? `${va.layerName}: ${va.name}` : '?'} &times; {vb ? `${vb.layerName}: ${vb.name}` : '?'}</span>
                      <button style={{ ...S.btnS, padding: '3px 10px', fontSize: 11 }} onClick={() => setIncompats(prev => prev.filter((_, j) => j !== i))}>Remove</button>
                    </div>
                  );
                })}
                {allVariants.length >= 2 && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <select style={{ ...S.select, flex: 1 }} value={incompatA} onChange={e => setIncompatA(e.target.value)}>
                      {allVariants.map(v => <option key={v.id} value={v.id}>{v.layerName}: {v.name}</option>)}
                    </select>
                    <span style={{ color: '#94a3b8', fontSize: 12 }}>×</span>
                    <select style={{ ...S.select, flex: 1 }} value={incompatB} onChange={e => setIncompatB(e.target.value)}>
                      {allVariants.map(v => <option key={v.id} value={v.id}>{v.layerName}: {v.name}</option>)}
                    </select>
                    <button style={S.btnS} onClick={() => { if (incompatA && incompatB && incompatA !== incompatB) setIncompats(prev => [...prev, { a: incompatA, b: incompatB }]); }}>Add</button>
                  </div>
                )}
              </div>

              <div style={S.row}>
                <button style={S.btnS} onClick={() => setStep(2)}>← Back</button>
                <button style={S.btnP} onClick={handleSaveTraits} disabled={busy}>{busy ? 'Saving…' : 'Save & Preview →'}</button>
              </div>
            </div>
          )}

          {/* ── Step 4: Preview ─────────────────────────────────────────────── */}
          {step === 4 && (
            <div>
              <h2 style={{ margin: '0 0 6px', fontSize: 18 }}>Preview</h2>
              <p style={{ margin: '0 0 18px', fontSize: 13, color: '#94a3b8' }}>Generate 5 sample NFTs to verify your layers and rarity weights.</p>
              {previews.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginBottom: 20 }}>
                  {previews.map((url, i) => (
                    <img key={i} src={url} alt={`Preview ${i + 1}`} style={{ width: '100%', aspectRatio: '1', borderRadius: 6, objectFit: 'cover', border: '1px solid #1e2030' }} />
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
                <button style={S.btnP} onClick={() => advanceStep(5)} disabled={previews.length === 0}>Generate Full Collection →</button>
              </div>
            </div>
          )}

          {/* ── Step 5: Generate ────────────────────────────────────────────── */}
          {step === 5 && (
            <div>
              <h2 style={{ margin: '0 0 6px', fontSize: 18 }}>Generate Collection</h2>
              <p style={{ margin: '0 0 16px', fontSize: 13, color: '#94a3b8' }}>
                Composite all {project?.total_supply} unique NFT images.
              </p>

              {!genStatus && (
                <div style={{ background: '#0f1016', border: '1px solid #1e2030', borderRadius: 8, padding: 16, marginBottom: 20 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Combination Analysis
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
                    {layers.map(l => (
                      <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                        <span style={{ color: '#94a3b8' }}>{l.name}</span>
                        <span style={{ color: '#94a3b8' }}>{l.variants.length} variant{l.variants.length !== 1 ? 's' : ''}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{ borderTop: '1px solid #1e2030', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span style={{ color: '#94a3b8' }}>Max unique combinations</span>
                      <span style={{ color: '#e2e8f0', fontWeight: 600 }}>{maxCombinations.toLocaleString()}</span>
                    </div>
                    {incompats.length > 0 && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                        <span style={{ color: '#94a3b8' }}>After {incompats.length} incompatibility rule{incompats.length !== 1 ? 's' : ''} (est.)</span>
                        <span style={{ color: '#e2e8f0', fontWeight: 600 }}>~{estimatedCombinations.toLocaleString()}</span>
                      </div>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span style={{ color: '#94a3b8' }}>Requested supply</span>
                      <span style={{ color: supplyFeasible ? '#4ade80' : '#f87171', fontWeight: 600 }}>
                        {project?.total_supply.toLocaleString()} {supplyFeasible ? '✓ feasible' : '✗ impossible'}
                      </span>
                    </div>
                    {saturation > 0.8 && supplyFeasible && (
                      <div style={{ marginTop: 4, fontSize: 12, color: '#fbbf24', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)', borderRadius: 6, padding: '8px 10px' }}>
                        ⚠ High saturation ({Math.round(saturation * 100)}% of possible combos used). Generation will slow significantly — consider adding more variants.
                      </div>
                    )}
                    {!supplyFeasible && (
                      <div style={{ marginTop: 4, fontSize: 12, color: '#f87171', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: 6, padding: '8px 10px' }}>
                        Cannot generate {project?.total_supply.toLocaleString()} unique NFTs — only ~{estimatedCombinations.toLocaleString()} unique combinations possible.
                        Go back to Layers to add more variants, or reduce your supply in Project settings.
                      </div>
                    )}
                  </div>
                </div>
              )}

              {genStatus ? (
                <>
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: 13 }}>
                      <span style={{ color: '#94a3b8' }}>{genStatus}</span>
                      <span style={{ color: '#fb923c', fontWeight: 600 }}>{genProgress}%</span>
                    </div>
                    <div style={{ height: 8, background: '#0f1016', borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{ height: '100%', borderRadius: 4, transition: 'width 0.5s ease', width: `${genProgress}%`, background: 'linear-gradient(90deg, #ea580c, #f97316)' }} />
                    </div>
                  </div>
                  {genStatus === 'Complete!' && (
                    <button style={S.btnP} onClick={() => advanceStep(6)}>View Rarity Report →</button>
                  )}
                </>
              ) : (
                <button style={{ ...S.btnP, opacity: !supplyFeasible ? 0.4 : 1 }}
                  onClick={handleGenerate} disabled={busy || !supplyFeasible}>
                  🚀 {supplyFeasible ? 'Start Generation' : 'Cannot Generate (impossible supply)'}
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
              <p style={{ margin: '0 0 18px', fontSize: 13, color: '#94a3b8' }}>Trait distribution across the generated collection.</p>
              {Object.keys(rarityData).length === 0 ? (
                <div style={{ color: '#94a3b8', fontSize: 13 }}>Loading rarity data…</div>
              ) : (
                Object.entries(rarityData).map(([layerName, traitCounts]) => {
                  const chartData = Object.entries(traitCounts).map(([n, count]) => ({ name: n, count }));
                  return (
                    <div key={layerName} style={{ marginBottom: 32 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#f97316', marginBottom: 10 }}>{layerName}</div>
                      <ResponsiveContainer width="100%" height={150}>
                        <BarChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#1e2030" />
                          <XAxis dataKey="name" tick={{ fill: '#94a3b8', fontSize: 11 }} />
                          <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} />
                          <Tooltip contentStyle={{ background: '#161720', border: '1px solid #2d2f3d', borderRadius: 6, fontSize: 12 }} labelStyle={{ color: '#e2e8f0' }} />
                          <Bar dataKey="count" fill="#f97316" radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  );
                })
              )}
              <div style={S.row}>
                <button style={S.btnP} onClick={() => advanceStep(7)}>Pin to IPFS →</button>
              </div>
            </div>
          )}

          {/* ── Step 7: IPFS ────────────────────────────────────────────────── */}
          {step === 7 && (
            <div>
              <h2 style={{ margin: '0 0 6px', fontSize: 18 }}>Pin to IPFS</h2>
              <p style={{ margin: '0 0 16px', fontSize: 13, color: '#94a3b8' }}>
                Your collection will be permanently hosted on IPFS.
              </p>

              {/* Test connection row */}
              <div style={{ background: '#0f1016', border: '1px solid #1e2030', borderRadius: 8, padding: 14, marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 13, color: '#94a3b8', flex: 1 }}>
                    {ipfsTestStatus?.service ? `Detected: ${ipfsTestStatus.service}` : 'Verify your connection before uploading'}
                  </span>
                  <button style={{ ...S.btnS, padding: '6px 14px', fontSize: 12 }} onClick={handleTestIPFS} disabled={ipfsTestBusy}>
                    {ipfsTestBusy ? 'Testing…' : 'Test Connection'}
                  </button>
                </div>
                {ipfsTestStatus && (
                  <div style={{ marginTop: 8, fontSize: 12, color: ipfsTestStatus.ok ? '#4ade80' : '#fbbf24' }}>
                    {ipfsTestStatus.ok
                      ? `✓ Connected via ${ipfsTestStatus.service}`
                      : 'IPFS service unavailable. Please contact support.'}
                  </div>
                )}
              </div>

              {/* Upload progress — shown while uploading or after completion */}
              {ipfsProgress.phase && (
                <div style={{ marginBottom: 16 }}>
                  {/* Phase 1: Images */}
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 13 }}>
                      <span style={{ color: ipfsProgress.phase === 'images' ? '#e2e8f0' : '#94a3b8' }}>
                        {ipfsProgress.phase === 'images' ? '↑ Uploading images…'
                          : ipfsProgress.imagesDone > 0 ? `✓ Images (${ipfsProgress.imagesDone}/${ipfsProgress.total})`
                          : 'Images'}
                      </span>
                      <span style={{ color: '#94a3b8', fontSize: 12 }}>
                        {ipfsProgress.imagesDone}/{ipfsProgress.total} ({Math.round(ipfsProgress.imagesDone / Math.max(1, ipfsProgress.total) * 100)}%)
                      </span>
                    </div>
                    <div style={{ height: 6, background: '#0f1016', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{
                        height: '100%', borderRadius: 3, transition: 'width 0.3s ease',
                        width: `${ipfsProgress.imagesDone / Math.max(1, ipfsProgress.total) * 100}%`,
                        background: ipfsProgress.phase === 'images' ? 'linear-gradient(90deg, #ea580c, #f97316)' : '#4ade80',
                      }} />
                    </div>
                  </div>

                  {/* Phase 2: Metadata */}
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 13 }}>
                      <span style={{ color: ipfsProgress.phase === 'metadata' ? '#e2e8f0' : '#94a3b8' }}>
                        {ipfsProgress.phase === 'metadata' ? '↑ Uploading metadata…'
                          : ipfsProgress.metaDone === ipfsProgress.total && ipfsProgress.total > 0 ? `✓ Metadata (${ipfsProgress.metaDone}/${ipfsProgress.total})`
                          : 'Metadata'}
                      </span>
                      <span style={{ color: '#94a3b8', fontSize: 12 }}>
                        {ipfsProgress.metaDone}/{ipfsProgress.total} ({Math.round(ipfsProgress.metaDone / Math.max(1, ipfsProgress.total) * 100)}%)
                      </span>
                    </div>
                    <div style={{ height: 6, background: '#0f1016', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{
                        height: '100%', borderRadius: 3, transition: 'width 0.3s ease',
                        width: `${ipfsProgress.metaDone / Math.max(1, ipfsProgress.total) * 100}%`,
                        background: ipfsProgress.phase === 'metadata' ? 'linear-gradient(90deg, #ea580c, #f97316)'
                          : ipfsProgress.metaDone === ipfsProgress.total && ipfsProgress.total > 0 ? '#4ade80' : '#1e2030',
                      }} />
                    </div>
                  </div>

                  {/* Current file + speed */}
                  {ipfsProgress.phase !== 'complete' && ipfsProgress.phase !== 'error' && (
                    <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
                      {ipfsProgress.currentFile && <span>Uploading: {ipfsProgress.currentFile}</span>}
                      {ipfsSpeedText && <span>{ipfsSpeedText}</span>}
                    </div>
                  )}

                  {/* Completion */}
                  {ipfsProgress.phase === 'complete' && (
                    <div style={{ marginTop: 8, padding: 14, background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.25)', borderRadius: 8 }}>
                      <div style={{ fontSize: 18, marginBottom: 6 }}>✓</div>
                      <div style={{ fontSize: 13, color: '#4ade80', marginBottom: ipfsCid ? 10 : 0 }}>
                        All {ipfsProgress.total} images and {ipfsProgress.total} metadata files pinned to IPFS
                        {ipfsService && <span style={{ color: '#94a3b8', fontSize: 11, marginLeft: 6 }}>via {ipfsService}</span>}
                      </div>
                      {ipfsCid && (
                        <div style={{ fontSize: 12 }}>
                          <span style={{ color: '#94a3b8' }}>Base URI: </span>
                          <span style={{ fontFamily: 'monospace', color: '#fb923c', wordBreak: 'break-all' }}>ipfs://{ipfsCid}</span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Error */}
                  {ipfsProgress.phase === 'error' && (
                    <div style={{ marginTop: 8, padding: 14, background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 8 }}>
                      <div style={{ fontSize: 13, color: '#f87171', marginBottom: 10 }}>
                        Upload failed{ipfsProgress.currentFile ? ` at ${ipfsProgress.currentFile}` : ''}.
                        Previously uploaded files will be skipped on retry.
                      </div>
                      <button style={S.btnP} onClick={handleIpfsPin} disabled={busy}>Retry Upload</button>
                    </div>
                  )}
                </div>
              )}

              {/* Pin button — only shown when not in progress */}
              {(!ipfsProgress.phase || ipfsProgress.phase === 'error') && ipfsProgress.phase !== 'error' && (
                <button style={S.btnP} onClick={handleIpfsPin} disabled={busy}>
                  {busy ? '📌 Uploading…' : '📌 Pin to IPFS'}
                </button>
              )}

              <div style={S.row}>
                <button style={S.btnS} onClick={() => setStep(6)} disabled={busy}>← Back</button>
                {ipfsProgress.phase === 'complete' && <button style={S.btnP} onClick={() => advanceStep(8)}>Launch →</button>}
              </div>
            </div>
          )}

          {/* ── Step 8: Launch ──────────────────────────────────────────────── */}
          {step === 8 && (
            <div>
              <h2 style={{ margin: '0 0 6px', fontSize: 18 }}>Launch on Marketplace</h2>
              <p style={{ margin: '0 0 20px', fontSize: 13, color: '#94a3b8' }}>
                Configure your mint and publish <strong style={{ color: '#e2e8f0' }}>{project?.name}</strong> to the Wiznerd Marketplace.
              </p>

              {/* Mint price */}
              <div style={{ marginBottom: 16 }}>
                <label style={S.label}>Mint price (XCH)</label>
                <input style={S.input} type="number" min="0" step="0.001" placeholder="0.5"
                  value={mintPriceXch} onChange={e => setMintPriceXch(e.target.value)} />
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>Set to 0 for a free mint</div>
              </div>

              {/* Launch timing */}
              <div style={{ marginBottom: 16 }}>
                <label style={S.label}>Launch timing</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 14 }}>
                    <input type="radio" checked={launchImmediate} onChange={() => setLaunchImmediate(true)} style={{ accentColor: '#f97316' }} />
                    Launch immediately
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 14 }}>
                    <input type="radio" checked={!launchImmediate} onChange={() => setLaunchImmediate(false)} style={{ accentColor: '#f97316' }} />
                    Schedule for later
                  </label>
                  {!launchImmediate && (
                    <input style={{ ...S.input, marginTop: 4 }} type="datetime-local"
                      value={launchAt} onChange={e => setLaunchAt(e.target.value)} />
                  )}
                </div>
              </div>

              {/* Reveal type */}
              <div style={{ marginBottom: 16 }}>
                <label style={S.label}>Reveal type</label>
                <div style={{ display: 'flex', gap: 10 }}>
                  {(['instant', 'blind'] as const).map(t => (
                    <label key={t} style={{
                      flex: 1, padding: '10px 14px', background: revealType === t ? 'rgba(249,115,22,0.1)' : '#0f1016',
                      border: `1px solid ${revealType === t ? '#f97316' : '#2d2f3d'}`, borderRadius: 8,
                      cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 4,
                    }}>
                      <input type="radio" checked={revealType === t} onChange={() => setRevealType(t)} style={{ display: 'none' }} />
                      <span style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0' }}>
                        {t === 'instant' ? 'Instant Reveal' : 'Blind Mint'}
                      </span>
                      <span style={{ fontSize: 11, color: '#94a3b8' }}>
                        {t === 'instant' ? 'Buyers see their NFT immediately after mint'
                          : 'NFTs are hidden until you reveal the collection'}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Allowlist */}
              <div style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                  <label style={{ ...S.label, margin: 0 }}>Allowlist (optional — one xch1 address per line)</label>
                  <label style={{ fontSize: 12, color: '#f97316', cursor: 'pointer', padding: '3px 10px', border: '1px solid #f97316', borderRadius: 6 }}>
                    Upload CSV
                    <input
                      type="file"
                      accept=".csv,.txt"
                      style={{ display: 'none' }}
                      onChange={e => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        const reader = new FileReader();
                        reader.onload = ev => {
                          const text = ev.target?.result as string;
                          const addresses = text.split(/[\r\n,;\t]+/)
                            .map(s => s.trim())
                            .filter(s => s.startsWith('xch1'));
                          setAllowlistText(prev => {
                            const existing = prev.split('\n').map(s => s.trim()).filter(Boolean);
                            const merged = [...new Set([...existing, ...addresses])];
                            return merged.join('\n');
                          });
                        };
                        reader.readAsText(file);
                        e.target.value = '';
                      }}
                    />
                  </label>
                </div>
                <textarea style={{ ...S.input, resize: 'vertical', minHeight: 80, fontFamily: 'monospace', fontSize: 12 }}
                  placeholder={'xch1aaa...\nxch1bbb...'}
                  value={allowlistText} onChange={e => setAllowlistText(e.target.value)} />
                {allowlistText.trim() && (
                  <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                    {allowlistText.split('\n').filter(s => s.trim().startsWith('xch1')).length} valid address(es)
                  </div>
                )}
              </div>

              {publishError && <div style={S.err}>{publishError}</div>}

              <div style={S.row}>
                <button style={S.btnS} onClick={() => setStep(7)}>← Back</button>
                <button style={S.btnP} onClick={handlePublish} disabled={publishBusy}>
                  {publishBusy ? 'Publishing…' : '🚀 Publish Collection'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
}
