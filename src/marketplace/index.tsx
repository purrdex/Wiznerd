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
  volume_7d_mojo?: number;
  sales_24h?: number;
  sales_7d?: number;
  mint_24h?: number;
  verified?: boolean;
  listed_count?: number;
}

interface NotableSale {
  nft_id: string | null;
  name: string | null;
  token_index: number | null;
  image_url: string | null;
  collection_id: string | null;
  collection_name: string | null;
  collection_thumb: string | null;
  price_mojo: number;
  price_token: string;
  sold_at: string;
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
  const [notableSales, setNotableSales] = useState<NotableSale[]>([]);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const walletAddress = (() => { try { return localStorage.getItem('chia_primary_address') || ''; } catch { return ''; } })();

  // Load favorites once on mount (wallet-connected users only)
  useEffect(() => {
    if (!walletAddress) return;
    fetch(`${API_URL}/api/favorites?address=${encodeURIComponent(walletAddress)}&type=collection`, { signal: AbortSignal.timeout(8000) })
      .then(r => r.ok ? r.json() : [])
      .then((favs: { item_id: string }[]) => setFavorites(new Set(favs.map(f => f.item_id))))
      .catch(() => {});
  }, [walletAddress]);

  function toggleFav(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    if (!walletAddress) return;
    const isFav = favorites.has(id);
    const next = new Set(favorites);
    if (isFav) {
      next.delete(id);
      fetch(`${API_URL}/api/favorites/collection/${encodeURIComponent(id)}?address=${encodeURIComponent(walletAddress)}`, { method: 'DELETE', signal: AbortSignal.timeout(5000) }).catch(() => {});
    } else {
      next.add(id);
      fetch(`${API_URL}/api/favorites`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: walletAddress, item_type: 'collection', item_id: id }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }
    setFavorites(next);
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const searchParam = search ? `&search=${encodeURIComponent(search)}` : '';
      const [wiznerdRes, extRes, priceRes, salesRes] = await Promise.all([
        fetch(`${API_URL}/api/marketplace/listings?filter=all${searchParam}`, { signal: AbortSignal.timeout(10000) }),
        fetch(`${API_URL}/api/marketplace/external${search ? `?search=${encodeURIComponent(search)}` : ''}`, { signal: AbortSignal.timeout(12000) }).catch(() => null),
        fetch(`${PROXY_URL}/price/xch`, { signal: AbortSignal.timeout(5000) }).catch(() => null),
        !search ? fetch(`${API_URL}/api/marketplace/notable-sales?limit=8`, { signal: AbortSignal.timeout(8000) }).catch(() => null) : Promise.resolve(null),
      ]);
      if (wiznerdRes.ok) setWiznerdListings(await wiznerdRes.json());
      if (extRes?.ok) setExternalListings(await extRes.json());
      if (priceRes?.ok) { const p = await priceRes.json(); if (p.price) setXchPrice(p.price); }
      if (salesRes?.ok) setNotableSales(await salesRes.json());
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
      if (filter === 'trending') return (c.minted_count ?? 0) > 0 || (c.indexed_count ?? 0) > 0;
      return true;
    });

    if (filter === 'trending') {
      list = [...list].sort((a, b) => {
        const sd = (b.trending_score ?? 0) - (a.trending_score ?? 0);
        if (sd !== 0) return sd;
        return (b.volume_7d_mojo ?? 0) - (a.volume_7d_mojo ?? 0);
      });
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
      <TopNav searchValue={search} onSearchChange={setSearch} searchPlaceholder="Search collections…" />

      {/* Filters */}
      <div className="mp-filters">
        {(['all', 'trending', 'live', 'upcoming'] as FilterKey[]).map(f => (
          <button key={f} className={`mp-filter-btn${filter === f ? ' active' : ''}`} onClick={() => setFilter(f)}>
            {FILTER_LABELS[f]}
          </button>
        ))}
      </div>

      {/* Notable Sales row — shown when on All tab with no search */}
      {!search && filter === 'all' && notableSales.length > 0 && (
        <div className="mp-section">
          <div className="mp-section-header">
            <span className="mp-section-title">Notable Sales</span>
            <a href="/marketplace/activity?type=sale" className="mp-section-more">See all →</a>
          </div>
          <div className="mp-scroll-row">
            {notableSales.map((s, i) => {
              const displayName = s.name || (s.token_index != null ? `#${s.token_index + 1}` : s.nft_id?.slice(0, 10) + '…');
              const priceXch = (s.price_mojo / 1e12).toFixed(s.price_mojo >= 1e12 ? 2 : 4).replace(/0+$/, '');
              return (
                <div
                  key={i}
                  className="mp-scroll-card"
                  onClick={() => s.collection_id && navigate(`/marketplace/${s.collection_id}${s.nft_id ? `?nft=${encodeURIComponent(s.nft_id)}` : ''}`)}
                >
                  <div className="mp-scroll-img">
                    {s.image_url
                      ? <img src={s.image_url} alt={displayName || ''} onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                      : <div className="mp-scroll-img-ph" />}
                  </div>
                  <div className="mp-scroll-body">
                    <div className="mp-scroll-name">{displayName}</div>
                    {s.collection_name && <div className="mp-scroll-sub">{s.collection_name}</div>}
                    <div className="mp-scroll-price">{priceXch} XCH</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}


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
            <div key={`${c.source}-${c.id}`} className="mp-card" onClick={() => handleCardClick(c)} style={{ position: 'relative' }}>
              {walletAddress && (
                <button
                  className={`mp-card-heart${favorites.has(c.id) ? ' hearted' : ''}`}
                  onClick={e => toggleFav(e, c.id)}
                  title={favorites.has(c.id) ? 'Remove from watchlist' : 'Add to watchlist'}
                >
                  {favorites.has(c.id) ? '♥' : '♡'}
                </button>
              )}
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
                  {c.verified && <span className="mp-verified-badge" title="Verified collection">✓</span>}
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
                          {(c.sales_24h ?? 0) > 0
                            ? `${c.sales_24h} trades 24h`
                            : `${c.sales_7d ?? 0} trades 7d`}
                        </span>
                        {((c.sales_24h ?? 0) > 0 ? (c.volume_24h_mojo ?? 0) : (c.volume_7d_mojo ?? 0)) > 0 && (
                          <span style={{ color: '#a0aec0', fontSize: 11 }}>
                            {formatXch((c.sales_24h ?? 0) > 0 ? c.volume_24h_mojo! : c.volume_7d_mojo!)} XCH
                          </span>
                        )}
                      </>
                    ) : (
                      <>
                        {(c.volume_7d_mojo ?? 0) > 0 && (
                          <span style={{ color: '#22d3ee', fontSize: 11 }}>
                            {formatXch(c.volume_7d_mojo!)} XCH 7d vol
                          </span>
                        )}
                        {(c.listed_count ?? 0) > 0 && (
                          <span style={{ color: '#f97316', fontSize: 11 }}>
                            {c.listed_count} listed
                          </span>
                        )}
                        {(c.volume_7d_mojo ?? 0) === 0 && (c.indexed_count ?? 0) > 0 && (
                          <span style={{ color: '#4a5568', fontSize: 11 }}>
                            {(c.indexed_count ?? 0).toLocaleString()} supply
                          </span>
                        )}
                      </>
                    )}
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
