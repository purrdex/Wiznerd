import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import './marketplace.css';
import TopNav from '../components/TopNav';

const API_URL   = (import.meta.env.VITE_API_URL   as string | undefined) || 'http://localhost:3002';
const PROXY_URL = (import.meta.env.VITE_PROXY_URL as string | undefined) || 'http://localhost:3001';

interface Listing {
  id: string;
  name: string;
  symbol?: string;
  total_supply: number;
  marketplace_status: string;
  mint_price_mojo: number;
  launch_at: string | null;
  minted_count: number;
  first_token_index?: number;
  thumbnail_url?: string;
  description?: string;
  source: 'wiznerd' | 'external';
  external_url?: string;
  indexed_count?: number;
  trending_score?: number;
  volume_24h_mojo?: number;
  sales_24h?: number;
  mint_24h?: number;
}

function formatXch(mojo: number): string {
  const v = Number(mojo) / 1e12;
  if (v === 0) return '0';
  return v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
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

type FilterKey = 'all' | 'trending' | 'wiznerd' | 'chia' | 'live' | 'upcoming' | 'soldout';
const FILTER_LABELS: Record<FilterKey, string> = {
  all: 'All', trending: 'Trending',
  wiznerd: 'Wiznerd', chia: 'Chia Network',
  live: 'Live Now', upcoming: 'Upcoming', soldout: 'Sold Out',
};

export default function MarketplaceScreen() {
  const navigate = useNavigate();
  const [wiznerdListings, setWiznerdListings] = useState<Listing[]>([]);
  const [externalListings, setExternalListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [search, setSearch] = useState('');
  const [xchPrice, setXchPrice] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const searchParam = search ? `&search=${encodeURIComponent(search)}` : '';
      const [wiznerdRes, extRes, priceRes] = await Promise.all([
        fetch(`${API_URL}/api/marketplace/listings?filter=all${searchParam}`, { signal: AbortSignal.timeout(10000) }),
        fetch(`${API_URL}/api/marketplace/external${search ? `?search=${encodeURIComponent(search)}` : ''}`, { signal: AbortSignal.timeout(12000) }).catch(() => null),
        fetch(`${PROXY_URL}/price/xch`, { signal: AbortSignal.timeout(5000) }).catch(() => null),
      ]);
      if (wiznerdRes.ok) setWiznerdListings(await wiznerdRes.json());
      if (extRes?.ok) setExternalListings(await extRes.json());
      if (priceRes?.ok) { const p = await priceRes.json(); if (p.price) setXchPrice(p.price); }
    } catch { /* server not running */ }
    finally { setLoading(false); }
  }, [search]);

  useEffect(() => { load(); }, [load]);

  const allListings = [...wiznerdListings, ...externalListings];

  const visible = (() => {
    let list = allListings.filter(c => {
      if (filter === 'wiznerd')  return c.source === 'wiznerd';
      if (filter === 'chia')     return c.source === 'external';
      if (filter === 'live')     return c.marketplace_status === 'live';
      if (filter === 'upcoming') return c.marketplace_status === 'scheduled';
      if (filter === 'soldout')  return c.marketplace_status === 'sold_out';
      if (filter === 'trending') return (c.trending_score ?? 0) > 0;
      return true;
    });

    if (filter === 'trending') {
      list = [...list].sort((a, b) => (b.trending_score ?? 0) - (a.trending_score ?? 0));
    } else if (filter === 'all') {
      list = [...list].sort((a, b) => {
        const aTrend = (a.trending_score ?? 0) > 0;
        const bTrend = (b.trending_score ?? 0) > 0;
        const aMint  = a.source === 'wiznerd' && a.marketplace_status === 'live';
        const bMint  = b.source === 'wiznerd' && b.marketplace_status === 'live';

        // Tier 1: trending
        if (aTrend !== bTrend) return aTrend ? -1 : 1;
        if (aTrend && bTrend)  return (b.trending_score ?? 0) - (a.trending_score ?? 0);

        // Tier 2: actively minting Wiznerd collections
        if (aMint !== bMint) return aMint ? -1 : 1;

        // Tier 3: everything else by minted_count
        return (b.minted_count ?? 0) - (a.minted_count ?? 0);
      });
    }

    return list;
  })();

  function handleCardClick(c: Listing) {
    navigate(`/marketplace/${c.id}`);
  }

  function cardImage(c: Listing): string {
    if (c.thumbnail_url) return c.thumbnail_url;
    if (c.source === 'wiznerd') return `${API_URL}/output/${c.id}/${c.first_token_index ?? 0}.png`;
    return '';
  }

  return (
    <div className="mp-page">
      <TopNav />

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
        {(['all', 'trending', 'live', 'upcoming'] as FilterKey[]).map(f => (
          <button key={f} className={`mp-filter-btn${filter === f ? ' active' : ''}`} onClick={() => setFilter(f)}>
            {FILTER_LABELS[f]}
          </button>
        ))}
      </div>

      {/* Grid */}
      <div className="mp-grid">
        {loading ? (
          <div className="mp-empty"><div className="mp-spinner" /></div>
        ) : visible.length === 0 ? (
          <div className="mp-empty">
            {filter === 'all' && !search ? 'No collections found.' : 'No collections match your filter.'}
          </div>
        ) : visible.map(c => {
          const xch = formatXch(c.mint_price_mojo);
          const pct = Math.min(100, Math.round((c.minted_count / Math.max(1, c.total_supply)) * 100));
          const img = cardImage(c);
          return (
            <div key={`${c.source}-${c.id}`} className="mp-card" onClick={() => handleCardClick(c)}>
              <div className="mp-card-img">
                {img ? (
                  <img src={img} alt={c.name} onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                ) : (
                  <div style={{ width: '100%', height: '100%', background: 'linear-gradient(135deg, #1a1d26, #0f1016)' }} />
                )}
              </div>
              <div className="mp-card-body">
                <div className="mp-card-name">
                  {c.name}
                  {c.symbol && <span className="mp-symbol">{c.symbol}</span>}
                </div>
                {c.description && (
                  <div className="mp-card-desc">{c.description}</div>
                )}
                <div className="mp-card-price">
                  {Number(xch) === 0
                    ? (c.source === 'wiznerd' ? 'Free' : '—')
                    : (c.source === 'external' ? `Floor: ${xch} XCH` : `${xch} XCH`)}
                  {xchPrice > 0 && Number(xch) > 0 && (
                    <span className="mp-usd">≈ ${(Number(xch) * xchPrice).toFixed(2)}</span>
                  )}
                </div>
                {c.source === 'external' && (
                  <div className="mp-card-foot">
                    {(c.trending_score ?? 0) > 0 ? (
                      <>
                        <span style={{ color: '#22d3ee', fontSize: 11 }}>
                          {c.sales_24h ?? 0} trades 24h
                        </span>
                        {(c.volume_24h_mojo ?? 0) > 0 && (
                          <span style={{ color: '#a0aec0', fontSize: 11 }}>
                            {formatXch(c.volume_24h_mojo!)} XCH
                          </span>
                        )}
                      </>
                    ) : (c.indexed_count ?? 0) > 0 ? (
                      <span style={{ color: '#4a5568', fontSize: 11 }}>
                        {(c.indexed_count ?? 0).toLocaleString()} supply
                      </span>
                    ) : null}
                  </div>
                )}
                {c.total_supply > 0 && c.source === 'wiznerd' && (
                  <>
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
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
