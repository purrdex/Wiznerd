import { useState, useEffect, useCallback, useMemo } from 'react';
import { AreaChart, Area, XAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { useParams, useNavigate } from 'react-router-dom';
import './marketplace.css';
import { supabase } from '../lib/supabase';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:3002';
const PROXY_URL = (import.meta.env.VITE_PROXY_URL as string | undefined) || 'http://localhost:3001';

interface Project {
  id: string; name: string; symbol: string; total_supply: number;
  creator_address: string; marketplace_status: string;
  reveal_type: string; mints_paused: boolean; mint_price_mojo: number;
}

interface Stats {
  mints_today: number; total_minted: number;
  total_revenue_mojo: number; remaining: number;
  mints_paused: boolean; marketplace_status: string;
}

interface Order {
  id: string; status: string; buyer_address: string | null;
  payment_address: string; payment_amount_mojo: number;
  tx_id: string | null; created_at: string; confirmed_at: string | null;
  token_id: string | null;
}

function formatXch(mojo: number): string {
  const v = Number(mojo) / 1e12;
  if (v === 0) return '0';
  return v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export default function ManageScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const walletAddress = (() => { try { return localStorage.getItem('chia_primary_address') || ''; } catch { return ''; } })();

  const [project, setProject] = useState<Project | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [xchPrice, setXchPrice] = useState(0);
  const [loading, setLoading] = useState(true);
  const [giftAddr, setGiftAddr] = useState('');
  const [giftBusy, setGiftBusy] = useState(false);
  const [giftMsg, setGiftMsg] = useState('');
  const [toggleBusy, setToggleBusy] = useState(false);
  const [revealBusy, setRevealBusy] = useState(false);
  const [error, setError] = useState('');

  const loadAll = useCallback(async () => {
    if (!id) return;
    try {
      const [projRes, statsRes, ordersRes, priceRes] = await Promise.all([
        fetch(`${API_URL}/api/marketplace/${id}`, { signal: AbortSignal.timeout(10000) }),
        fetch(`${API_URL}/api/marketplace/${id}/stats`, { signal: AbortSignal.timeout(10000) }),
        fetch(`${API_URL}/api/marketplace/${id}/orders`, { signal: AbortSignal.timeout(10000) }),
        fetch(`${PROXY_URL}/price/xch`, { signal: AbortSignal.timeout(5000) }).catch(() => null),
      ]);
      if (projRes.ok)   setProject(await projRes.json());
      if (statsRes.ok)  setStats(await statsRes.json());
      if (ordersRes.ok) setOrders(await ordersRes.json());
      if (priceRes?.ok) { const p = await priceRes.json(); if (p.price) setXchPrice(p.price); }
    } catch { /* server might not be running */ }
    finally { setLoading(false); }
  }, [id]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Realtime: refresh stats when orders change
  useEffect(() => {
    if (!id) return;
    const ch = supabase.channel(`manage-orders-${id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `project_id=eq.${id}` },
        () => { loadAll(); })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [id, loadAll]);

  const isCreator = project?.creator_address === walletAddress;

  async function togglePause() {
    if (!stats || !id) return;
    setToggleBusy(true); setError('');
    try {
      const ep = stats.mints_paused ? 'resume' : 'pause';
      const res = await fetch(`${API_URL}/api/marketplace/${id}/${ep}`, { method: 'POST', signal: AbortSignal.timeout(5000) });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `Server error ${res.status}`); }
      await loadAll();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setToggleBusy(false); }
  }

  async function handleReveal() {
    if (!id) return;
    setRevealBusy(true); setError('');
    try {
      const res = await fetch(`${API_URL}/api/marketplace/${id}/reveal`, { method: 'POST', signal: AbortSignal.timeout(5000) });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `Server error ${res.status}`); }
      await loadAll();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setRevealBusy(false); }
  }

  async function handleGift() {
    if (!id || !giftAddr.startsWith('xch1')) { setGiftMsg('Enter a valid xch1 address'); return; }
    setGiftBusy(true); setGiftMsg('');
    try {
      const res = await fetch(`${API_URL}/api/marketplace/${id}/gift`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient_address: giftAddr }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setGiftMsg(`✓ Gift order created (${data.order_id.slice(0, 8)}…)`);
      setGiftAddr('');
      setTimeout(loadAll, 3000);
    } catch (e: unknown) {
      setGiftMsg(e instanceof Error ? e.message : String(e));
    } finally { setGiftBusy(false); }
  }

  function handleExport() {
    window.location.href = `${API_URL}/api/marketplace/${id}/export`;
  }

  if (loading) {
    return (
      <div className="mp-page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <div className="mp-spinner" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="mp-page">
        <nav className="mp-nav">
          <a href="/marketplace" className="mp-nav-logo">Wiznerd<span>.</span></a>
        </nav>
        <div className="mp-unauth"><h2>Collection not found</h2></div>
      </div>
    );
  }

  if (!walletAddress) {
    return (
      <div className="mp-page">
        <nav className="mp-nav">
          <a href="/marketplace" className="mp-nav-logo">Wiznerd<span>.</span></a>
        </nav>
        <div className="mp-unauth">
          <h2>Wallet not connected</h2>
          <p>Open the wallet and unlock it to access the management dashboard.</p>
          <button className="mp-btn-primary" style={{ marginTop: 24 }} onClick={() => navigate('/')}>
            Open Wallet
          </button>
        </div>
      </div>
    );
  }

  if (!isCreator) {
    return (
      <div className="mp-page">
        <nav className="mp-nav">
          <a href="/marketplace" className="mp-nav-logo">Wiznerd<span>.</span></a>
        </nav>
        <div className="mp-unauth">
          <h2>Access Denied</h2>
          <p>Only the collection creator can access this dashboard.</p>
          <button className="mp-btn-primary" style={{ marginTop: 24 }}
            onClick={() => navigate(`/marketplace/${id}`)}>
            View Collection
          </button>
        </div>
      </div>
    );
  }

  const revenueXch = formatXch(stats?.total_revenue_mojo ?? 0);
  const revealable = project.reveal_type === 'blind';

  const revenueChart = useMemo(() => {
    const confirmed = orders.filter(o => o.status === 'confirmed' && o.confirmed_at);
    const byDay: Record<string, number> = {};
    const now = Date.now();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now - i * 86400000);
      byDay[d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })] = 0;
    }
    for (const o of confirmed) {
      const label = new Date(o.confirmed_at!).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      if (label in byDay) byDay[label] = (byDay[label] || 0) + Number(o.payment_amount_mojo) / 1e12;
    }
    return Object.entries(byDay).map(([date, xch]) => ({ date, xch: Math.round(xch * 1000) / 1000 }));
  }, [orders]);

  return (
    <div className="mp-page">
      {/* Nav */}
      <nav className="mp-nav">
        <a href="/" className="mp-nav-logo">Wiznerd<span>.</span></a>
        <button className="mp-nav-link" style={{ background: 'none', border: 'none', cursor: 'pointer' }}
          onClick={() => navigate(`/marketplace/${id}`)}>
          ← Collection
        </button>
        <a href="/marketplace" className="mp-nav-link">Marketplace</a>
      </nav>

      <div className="mp-manage">
        <h2>{project.name} — Management</h2>
        <div className="mp-manage-sub">
          <span className={`mp-badge mp-badge-${stats?.marketplace_status || project.marketplace_status}`} style={{ marginRight: 10 }}>
            {stats?.marketplace_status || project.marketplace_status}
          </span>
          {stats?.mints_paused && <span style={{ fontSize: 12, color: '#fbbf24' }}>⏸ Minting paused</span>}
        </div>

        {error && <div className="mp-error-box">{error}</div>}

        {/* Stats */}
        <div className="mp-stat-grid">
          <div className="mp-manage-stat">
            <div className="mp-manage-stat-label">Mints Today</div>
            <div className="mp-manage-stat-val">{stats?.mints_today ?? '—'}</div>
          </div>
          <div className="mp-manage-stat">
            <div className="mp-manage-stat-label">Total Minted</div>
            <div className="mp-manage-stat-val">{stats?.total_minted ?? '—'}</div>
          </div>
          <div className="mp-manage-stat">
            <div className="mp-manage-stat-label">Remaining</div>
            <div className="mp-manage-stat-val">{stats?.remaining ?? '—'}</div>
          </div>
          <div className="mp-manage-stat">
            <div className="mp-manage-stat-label">Total Revenue</div>
            <div className="mp-manage-stat-val">{revenueXch} XCH</div>
            {xchPrice > 0 && Number(revenueXch) > 0 && (
              <div className="mp-manage-stat-sub">≈ ${(Number(revenueXch) * xchPrice).toFixed(2)}</div>
            )}
          </div>
        </div>

        {/* Revenue sparkline */}
        {revenueChart.some(d => d.xch > 0) && (
          <div style={{ marginBottom: 28 }}>
            <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
              Revenue — last 30 days (XCH)
            </div>
            <ResponsiveContainer width="100%" height={80}>
              <AreaChart data={revenueChart} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="rev-grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f97316" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#f97316" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" hide />
                <Tooltip
                  contentStyle={{ background: '#111218', border: '1px solid #1e2030', borderRadius: 6, fontSize: 12 }}
                  labelStyle={{ color: '#94a3b8' }}
                  formatter={(v) => [`${v ?? 0} XCH`, 'Revenue']}
                />
                <Area type="monotone" dataKey="xch" stroke="#f97316" strokeWidth={2} fill="url(#rev-grad)" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Actions */}
        <div className="mp-actions">
          <button className={`mp-btn-${stats?.mints_paused ? 'primary' : 'secondary'}`}
            onClick={togglePause} disabled={toggleBusy}>
            {toggleBusy ? '…' : stats?.mints_paused ? '▶ Resume Minting' : '⏸ Pause Minting'}
          </button>
          {revealable && project.reveal_type !== 'revealed' && (
            <button className="mp-btn-primary" onClick={handleReveal} disabled={revealBusy}>
              {revealBusy ? 'Revealing…' : '👁 Reveal Collection'}
            </button>
          )}
          {revealable && project.reveal_type === 'revealed' && (
            <span style={{ fontSize: 13, color: '#4ade80', padding: '10px 0' }}>✓ Collection revealed</span>
          )}
          <button className="mp-btn-secondary" onClick={handleExport}>⬇ Export CSV</button>
          <button className="mp-btn-secondary" onClick={() => navigate(`/marketplace/${id}`)}>
            View Public Page →
          </button>
        </div>

        {/* Manual gift */}
        <div className="mp-section-title">Gift an NFT</div>
        <div className="mp-gift-form">
          <input
            className="mp-gift-input"
            placeholder="xch1recipient…"
            value={giftAddr}
            onChange={e => setGiftAddr(e.target.value)}
          />
          <button className="mp-btn-primary" onClick={handleGift} disabled={giftBusy}>
            {giftBusy ? '…' : 'Gift'}
          </button>
        </div>
        {giftMsg && (
          <div style={{ fontSize: 13, color: giftMsg.startsWith('✓') ? '#4ade80' : '#f87171', marginBottom: 24 }}>
            {giftMsg}
          </div>
        )}

        {/* Orders table */}
        <div className="mp-section-title">Orders ({orders.length})</div>
        <div className="mp-table-wrap">
          <table className="mp-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Buyer</th>
                <th>Amount</th>
                <th>Created</th>
                <th>Confirmed</th>
                <th>TX ID</th>
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 ? (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: '#94a3b8', fontFamily: 'system-ui' }}>No orders yet</td></tr>
              ) : orders.map(o => (
                <tr key={o.id}>
                  <td><span className={`mp-status-pill ${o.status}`}>{o.status.replace(/_/g, ' ')}</span></td>
                  <td style={{ fontSize: 11 }}>{o.buyer_address ? `${o.buyer_address.slice(0, 12)}…` : '—'}</td>
                  <td>{formatXch(o.payment_amount_mojo)} XCH</td>
                  <td style={{ fontSize: 11, fontFamily: 'system-ui' }}>{fmtDate(o.created_at)}</td>
                  <td style={{ fontSize: 11, fontFamily: 'system-ui' }}>{fmtDate(o.confirmed_at)}</td>
                  <td style={{ fontSize: 10, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {o.tx_id ? `${o.tx_id.slice(0, 12)}…` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
