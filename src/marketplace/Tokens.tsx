import { useState, useEffect } from 'react';
import TopNav from '../components/TopNav';
import { useNavigate } from 'react-router-dom';
import './Tokens.css';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:3002';
const XCH_USD_KEY = 'xch_price_usd';

interface TokenRow {
  asset_id: string;
  name: string | null;
  short_name: string | null;
  image_url: string | null;
  tibet_pair_id: string | null;
  current_price_xch: number | null;
  xch_reserve: number | null;
  token_reserve: number | null;
  volume_24h_xch: number;
  volume_7d_xch: number;
  dexie_depth_xch: number;
  liquidity_xch: number;
  sparkline_7d: number[];
}

const VOL_FILTERS = [
  { label: 'All',      min: 0 },
  { label: '>1 XCH',  min: 1 },
  { label: '>10 XCH', min: 10 },
  { label: '>100 XCH',min: 100 },
] as const;

function fmtXch(v: number | null, digits = 6): string {
  if (v == null) return '—';
  if (v < 0.000001) return '<0.000001';
  return v.toFixed(digits).replace(/\.?0+$/, '');
}

function fmtUsd(xch: number | null, xchPrice: number): string {
  if (xch == null || !xchPrice) return '—';
  const usd = xch * xchPrice;
  if (usd < 0.0001) return '<$0.0001';
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function fmtLiquidity(liquidityXch: number | null, xchPrice: number): string {
  if (!liquidityXch || !xchPrice) return '—';
  const usd = Number(liquidityXch) * xchPrice;
  if (usd < 1000) return `$${usd.toFixed(0)}`;
  if (usd < 1_000_000) return `$${(usd / 1000).toFixed(1)}K`;
  return `$${(usd / 1_000_000).toFixed(2)}M`;
}

function Sparkline({ prices }: { prices: number[] }) {
  if (prices.length < 2) return <span style={{ display: 'inline-block', width: 80, height: 32 }} />;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || min * 0.001 || 1;
  const W = 80, H = 32, pad = 2;
  const pts = prices.map((p, i) => {
    const x = pad + (i / (prices.length - 1)) * (W - pad * 2);
    const y = pad + ((max - p) / range) * (H - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const rising = prices[prices.length - 1] >= prices[0];
  return (
    <svg width={W} height={H} style={{ display: 'block', overflow: 'visible' }}>
      <polyline points={pts} fill="none"
        stroke={rising ? '#4ade80' : '#f87171'}
        strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export default function TokensScreen() {
  const nav = useNavigate();
  const [tokens, setTokens]     = useState<TokenRow[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [search, setSearch]     = useState('');
  const [xchPrice, setXchPrice] = useState(0);
  const [sort, setSort]         = useState<'price' | 'liquidity' | 'vol24h' | 'vol7d'>('liquidity');
  const [minVol7d, setMinVol7d] = useState(0);
  const [hideLp, setHideLp]       = useState(true);
  const [hideUsdc, setHideUsdc]   = useState(true);

  useEffect(() => {
    const cached = parseFloat(localStorage.getItem(XCH_USD_KEY) || '0');
    if (cached) setXchPrice(cached);
    fetch('https://wiznerd.fun/proxy/price/xch', { signal: AbortSignal.timeout(5000) })
      .then(r => r.json()).then(d => { if (d.price) { setXchPrice(d.price); localStorage.setItem(XCH_USD_KEY, String(d.price)); } })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    const qs = search ? `?q=${encodeURIComponent(search)}&limit=1000` : '?limit=1000';
    fetch(`${API_URL}/api/tokens${qs}`, { signal: AbortSignal.timeout(10000) })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => { setTokens(data); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [search]);

  const sorted = [...tokens]
    .filter(t => !hideLp   || !((t.name || t.short_name || '').toLowerCase().includes('tibetswap lp')))
    .filter(t => !hideUsdc || !((t.name || t.short_name || '').toLowerCase().includes('usdc')))
    .filter(t => t.volume_7d_xch >= minVol7d)
    .sort((a, b) => {
      if (sort === 'price')     return (b.current_price_xch ?? -1) - (a.current_price_xch ?? -1);
      if (sort === 'vol24h')    return (b.volume_24h_xch ?? 0) - (a.volume_24h_xch ?? 0);
      if (sort === 'vol7d')     return (b.volume_7d_xch  ?? 0) - (a.volume_7d_xch  ?? 0);
      return (b.liquidity_xch ?? 0) - (a.liquidity_xch ?? 0);
    });

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
      <TopNav activePath="/tokens" />

      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 16px' }}>
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 10 }}>
            <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: 'var(--accent)' }}>CAT Tokens</h1>
            <input
              type="text"
              placeholder="Search tokens…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ padding: '8px 12px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', fontSize: 13, width: 200 }}
            />
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)', marginRight: 2 }}>Sort:</span>
            {([['liquidity','Liquidity'],['price','Price'],['vol24h','24h Vol'],['vol7d','7d Vol']] as const).map(([s, label]) => (
              <button key={s} onClick={() => setSort(s)}
                style={{ padding: '6px 12px', borderRadius: 'var(--radius)', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                  background: sort === s ? 'var(--accent)' : 'var(--bg-card)',
                  color: sort === s ? '#fff' : 'var(--text-secondary)' }}>
                {label}
              </button>
            ))}
            <div style={{ width: 1, height: 18, background: 'var(--border)', margin: '0 4px' }} />
            <span style={{ fontSize: 11, color: 'var(--text-secondary)', marginRight: 2 }}>7d Vol:</span>
            {VOL_FILTERS.map(f => (
              <button key={f.min} onClick={() => setMinVol7d(f.min)}
                style={{ padding: '6px 12px', borderRadius: 'var(--radius)', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                  background: minVol7d === f.min ? 'var(--accent)' : 'var(--bg-card)',
                  color: minVol7d === f.min ? '#fff' : 'var(--text-secondary)' }}>
                {f.label}
              </button>
            ))}
            <div style={{ width: 1, height: 18, background: 'var(--border)', margin: '0 4px' }} />
            <button onClick={() => setHideLp(v => !v)}
              style={{ padding: '6px 12px', borderRadius: 'var(--radius)', border: `1px solid ${hideLp ? 'var(--accent)' : 'transparent'}`, cursor: 'pointer', fontSize: 12, fontWeight: 600,
                background: 'var(--bg-card)', color: hideLp ? 'var(--accent)' : 'var(--text-secondary)' }}>
              {hideLp ? 'Hide LP' : 'Show LP'}
            </button>
            <button onClick={() => setHideUsdc(v => !v)}
              style={{ padding: '6px 12px', borderRadius: 'var(--radius)', border: `1px solid ${hideUsdc ? 'var(--accent)' : 'transparent'}`, cursor: 'pointer', fontSize: 12, fontWeight: 600,
                background: 'var(--bg-card)', color: hideUsdc ? 'var(--accent)' : 'var(--text-secondary)' }}>
              {hideUsdc ? 'Hide USDC' : 'Show USDC'}
            </button>
          </div>
        </div>

        {loading && <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: 40 }}>Loading tokens…</div>}
        {error   && <div style={{ color: 'var(--error)', textAlign: 'center', padding: 40 }}>{error}</div>}

        {!loading && !error && (
          <>
            {sorted.length === 0 && (
              <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: 40 }}>
                {search ? 'No tokens match your search.' : 'No tokens indexed yet. Run tibet-sync then cat-backfill to populate.'}
              </div>
            )}

            {sorted.length > 0 && (
              <div style={{ overflowX: 'auto' }}>
                <table className="tok-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)', textAlign: 'left' }}>
                      <th className="col-rank" style={{ padding: '10px 12px' }}>#</th>
                      <th className="col-token" style={{ padding: '10px 12px' }}>Token</th>
                      <th style={{ padding: '10px 12px', textAlign: 'right' }}>Price (XCH)</th>
                      <th style={{ padding: '10px 12px', textAlign: 'right' }}>Price (USD)</th>
                      <th style={{ padding: '10px 12px' }}>7d</th>
                      <th style={{ padding: '10px 12px', textAlign: 'right' }}>Liquidity</th>
                      <th style={{ padding: '10px 12px', textAlign: 'right' }}>24h Volume</th>
                      <th style={{ padding: '10px 12px', textAlign: 'right' }}>7d Volume</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((t, i) => (
                      <tr key={t.asset_id}
                        onClick={() => nav(`/tokens/${t.asset_id}`)}
                        style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer', transition: 'background 0.1s' }}>
                        <td className="col-rank" style={{ padding: '12px 12px', color: 'var(--text-secondary)' }}>{i + 1}</td>
                        <td className="col-token" style={{ padding: '12px 12px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            {t.image_url
                              ? <img src={t.image_url} alt="" style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} onError={e => { e.currentTarget.style.display = 'none'; }} />
                              : <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--bg-input)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, color: 'var(--text-secondary)' }}>{(t.short_name || t.name || '?')[0]}</div>
                            }
                            <div>
                              <div style={{ fontWeight: 600 }}>{t.name || t.short_name || t.asset_id.slice(0, 8)}</div>
                              {t.short_name && <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{t.short_name}</div>}
                            </div>
                          </div>
                        </td>
                        <td style={{ padding: '12px 12px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                          {fmtXch(t.current_price_xch, 8)}
                        </td>
                        <td style={{ padding: '12px 12px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                          {fmtUsd(t.current_price_xch, xchPrice)}
                        </td>
                        <td style={{ padding: '8px 12px' }}>
                          <Sparkline prices={t.sparkline_7d} />
                        </td>
                        <td style={{ padding: '12px 12px', textAlign: 'right', fontSize: 12, color: 'var(--text-secondary)' }}>
                          {fmtLiquidity(t.liquidity_xch, xchPrice)}
                        </td>
                        <td style={{ padding: '12px 12px', textAlign: 'right', fontSize: 12, color: 'var(--text-secondary)' }}>
                          {t.volume_24h_xch > 0 ? `${fmtXch(t.volume_24h_xch, 2)} XCH` : '—'}
                        </td>
                        <td style={{ padding: '12px 12px', textAlign: 'right', fontSize: 12, color: 'var(--text-secondary)' }}>
                          {t.volume_7d_xch > 0 ? `${fmtXch(t.volume_7d_xch, 2)} XCH` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
