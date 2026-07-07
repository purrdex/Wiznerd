import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import './marketplace.css';
import TopNav from '../components/TopNav';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:3002';

interface WatchlistCollection {
  id: string;
  name: string;
  thumbnail_url: string;
  verified: boolean;
  total_supply: number;
  minted_count: number;
  floor_price_mojo: number;
  volume_7d_mojo: number;
  sales_7d: number;
  trending_score: number;
  listed_count: number;
}

function formatXch(mojo: number) {
  if (!mojo) return '0';
  const v = mojo / 1e12;
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (v >= 1)    return v.toFixed(2).replace(/\.?0+$/, '');
  return v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

export default function WatchlistScreen() {
  const navigate = useNavigate();
  const [walletAddress] = useState(() => {
    try { return localStorage.getItem('chia_primary_address') || ''; } catch { return ''; }
  });
  const [collections, setCollections] = useState<WatchlistCollection[]>([]);
  const [loading, setLoading] = useState(true);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!walletAddress) { setLoading(false); return; }
    Promise.all([
      fetch(`${API_URL}/api/favorites/collections?address=${encodeURIComponent(walletAddress)}`, { signal: AbortSignal.timeout(10000) })
        .then(r => r.ok ? r.json() : []),
      fetch(`${API_URL}/api/favorites?address=${encodeURIComponent(walletAddress)}&type=collection`, { signal: AbortSignal.timeout(10000) })
        .then(r => r.ok ? r.json() : []),
    ])
      .then(([cols, favs]) => {
        setCollections(cols);
        setFavorites(new Set(favs.map((f: { item_id: string }) => f.item_id)));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [walletAddress]);

  function toggleFav(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    if (!walletAddress) return;
    const isFav = favorites.has(id);
    if (isFav) {
      setFavorites(prev => { const s = new Set(prev); s.delete(id); return s; });
      setCollections(prev => prev.filter(c => c.id !== id));
      fetch(`${API_URL}/api/favorites/collection/${encodeURIComponent(id)}?address=${encodeURIComponent(walletAddress)}`, {
        method: 'DELETE', signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    } else {
      setFavorites(prev => new Set(prev).add(id));
      fetch(`${API_URL}/api/favorites`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: walletAddress, item_type: 'collection', item_id: id }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }
  }

  if (!walletAddress) {
    return (
      <div className="mp-page">
        <TopNav activePath="/marketplace/watchlist" />
        <div style={{ textAlign: 'center', padding: '80px 24px', color: '#4b5563' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🔑</div>
          <div style={{ fontSize: 18, color: '#94a3b8', marginBottom: 8 }}>No wallet connected</div>
          <div style={{ fontSize: 14, marginBottom: 24 }}>Connect a wallet to manage your watchlist.</div>
          <button className="mp-btn-primary" onClick={() => navigate('/')}>Open Wallet</button>
        </div>
      </div>
    );
  }

  return (
    <div className="mp-page">
      <TopNav activePath="/marketplace/watchlist" />

      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '32px 24px 64px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>
            Watchlist
            {collections.length > 0 && <span style={{ color: '#4b5563', fontWeight: 400, fontSize: 14, marginLeft: 10 }}>{collections.length} collection{collections.length !== 1 ? 's' : ''}</span>}
          </h1>
          <a href="/marketplace" className="mp-btn-secondary" style={{ textDecoration: 'none', padding: '8px 16px', fontSize: 13 }}>
            Browse Marketplace
          </a>
        </div>

        {loading ? (
          <div className="mp-empty"><div className="mp-spinner" /></div>
        ) : collections.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '80px 24px' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>♡</div>
            <div style={{ fontSize: 18, color: '#94a3b8', marginBottom: 8 }}>Your watchlist is empty</div>
            <div style={{ fontSize: 14, color: '#4b5563', marginBottom: 24 }}>
              Click the heart icon on any collection to add it here.
            </div>
            <button className="mp-btn-primary" onClick={() => navigate('/marketplace')}>Browse Collections</button>
          </div>
        ) : (
          <div className="mp-grid">
            {collections.map(c => (
              <div key={c.id} className="mp-card" onClick={() => navigate(`/marketplace/${c.id}`)} style={{ position: 'relative' }}>
                <button
                  className={`mp-card-heart${favorites.has(c.id) ? ' hearted' : ''}`}
                  onClick={e => toggleFav(e, c.id)}
                  title="Remove from watchlist"
                >
                  {favorites.has(c.id) ? '♥' : '♡'}
                </button>
                <div className="mp-card-img">
                  {c.thumbnail_url
                    ? <img src={c.thumbnail_url} alt={c.name} onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                    : <div style={{ width: '100%', height: '100%', background: 'linear-gradient(135deg, #1a1d26, #0f1016)' }} />}
                </div>
                <div className="mp-card-body">
                  <div className="mp-card-name">
                    {c.name}
                    {c.verified && <span className="mp-verified-badge" title="Verified">✓</span>}
                  </div>
                  <div className="mp-card-price">
                    {c.floor_price_mojo > 0 ? `Floor: ${formatXch(c.floor_price_mojo)} XCH` : '—'}
                  </div>
                  <div className="mp-card-foot">
                    {c.volume_7d_mojo > 0 && (
                      <span style={{ color: '#22d3ee', fontSize: 11 }}>{formatXch(c.volume_7d_mojo)} XCH 7d vol</span>
                    )}
                    {c.listed_count > 0 && (
                      <span style={{ color: '#f97316', fontSize: 11 }}>{c.listed_count} listed</span>
                    )}
                    {c.volume_7d_mojo === 0 && c.minted_count > 0 && (
                      <span style={{ color: '#4a5568', fontSize: 11 }}>{c.minted_count.toLocaleString()} supply</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
