import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import './marketplace.css';

const API_URL   = (import.meta.env.VITE_API_URL   as string | undefined) || 'http://localhost:3002';
const PROXY_URL = (import.meta.env.VITE_PROXY_URL as string | undefined) || 'http://localhost:3001';

interface Listing {
  id: string;
  name: string;
  symbol: string;
  total_supply: number;
  marketplace_status: string;
  mint_price_mojo: number;
  launch_at: string | null;
  minted_count: number;
  first_token_index: number;
}

function formatXch(mojo: number): string {
  const v = Number(mojo) / 1e12;
  if (v === 0) return '0';
  const s = v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

function Countdown({ launchAt }: { launchAt: string }) {
  const [label, setLabel] = useState('');
  useEffect(() => {
    function tick() {
      const diff = new Date(launchAt).getTime() - Date.now();
      if (diff <= 0) { setLabel('Live!'); return; }
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setLabel(h > 23 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${m}m ${s}s`);
    }
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [launchAt]);
  return <>{label}</>;
}

export default function MarketplaceScreen() {
  const navigate = useNavigate();
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [xchPrice, setXchPrice] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ filter });
      if (search) params.set('search', search);
      const [listRes, priceRes] = await Promise.all([
        fetch(`${API_URL}/api/marketplace/listings?${params}`, { signal: AbortSignal.timeout(10000) }),
        fetch(`${PROXY_URL}/price/xch`, { signal: AbortSignal.timeout(5000) }).catch(() => null),
      ]);
      if (listRes.ok) setListings(await listRes.json());
      if (priceRes?.ok) { const p = await priceRes.json(); if (p.price) setXchPrice(p.price); }
    } catch { /* server not running */ }
    finally { setLoading(false); }
  }, [filter, search]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="mp-page">
      {/* Nav */}
      <nav className="mp-nav">
        <a href="/" className="mp-nav-logo">Wiznerd<span>.</span></a>
        <a href="/marketplace" className="mp-nav-link active">Marketplace</a>
        <a href="/create" className="mp-nav-link">Create</a>
        <a href="/" className="mp-nav-link">Wallet</a>
      </nav>

      {/* Hero bar */}
      <div className="mp-hero-bar">
        <div className="mp-hero-inner">
          <h1>Marketplace</h1>
          <input
            className="mp-search"
            type="text"
            placeholder="Search collections…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Filters */}
      <div className="mp-filters">
        {(['all', 'live', 'upcoming', 'soldout'] as const).map(f => (
          <button key={f} className={`mp-filter-btn${filter === f ? ' active' : ''}`} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'live' ? 'Live Now' : f === 'upcoming' ? 'Upcoming' : 'Sold Out'}
          </button>
        ))}
      </div>

      {/* Grid */}
      <div className="mp-grid">
        {loading ? (
          <div className="mp-empty"><div className="mp-spinner" /></div>
        ) : listings.length === 0 ? (
          <div className="mp-empty">
            {filter === 'all' && !search ? 'No collections published yet.' : 'No collections match your filter.'}
          </div>
        ) : listings.map(c => {
          const xch = formatXch(c.mint_price_mojo);
          const pct = Math.min(100, Math.round((c.minted_count / Math.max(1, c.total_supply)) * 100));
          return (
            <div key={c.id} className="mp-card" onClick={() => navigate(`/marketplace/${c.id}`)}>
              <div className="mp-card-img">
                <img
                  src={`${API_URL}/output/${c.id}/${c.first_token_index}.png`}
                  alt={c.name}
                  onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              </div>
              <div className="mp-card-body">
                <div className="mp-card-name">
                  {c.name}
                  <span className="mp-symbol">{c.symbol}</span>
                </div>
                <div className="mp-card-price">
                  {Number(xch) === 0 ? 'Free' : `${xch} XCH`}
                  {xchPrice > 0 && Number(xch) > 0 && (
                    <span className="mp-usd">≈ ${(Number(xch) * xchPrice).toFixed(2)}</span>
                  )}
                </div>
                <div className="mp-supply-bar">
                  <div className="mp-supply-fill" style={{ width: `${pct}%` }} />
                </div>
                <div className="mp-card-foot">
                  <span>{c.minted_count} / {c.total_supply} minted</span>
                  <span className={`mp-badge mp-badge-${c.marketplace_status}`}>
                    {c.marketplace_status === 'live' ? '● Live'
                      : c.marketplace_status === 'scheduled' && c.launch_at
                      ? <Countdown launchAt={c.launch_at} />
                      : c.marketplace_status === 'sold_out' ? 'Sold Out'
                      : c.marketplace_status}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
