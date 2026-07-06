import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import TopNav from '../components/TopNav';
import './marketplace.css';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:3002';

interface CreatorCollection {
  id: string; name: string; symbol: string; total_supply: number;
  mint_price_mojo: number; marketplace_status: string; minted_count: number;
  collection_image_url?: string; collection_image_path?: string;
  royalty_percent: number;
}

interface CreatorProfile {
  address: string;
  collections: CreatorCollection[];
  total_revenue_mojo: number;
  total_minted: number;
}

function formatXch(mojo: number) {
  if (!mojo) return '0';
  return (mojo / 1e12).toFixed(mojo >= 1e12 ? 2 : 4).replace(/\.?0+$/, '');
}

function collImg(c: CreatorCollection): string {
  if (c.collection_image_url) {
    return c.collection_image_url.startsWith('ipfs://')
      ? `https://gateway.pinata.cloud/ipfs/${c.collection_image_url.replace('ipfs://', '')}`
      : c.collection_image_url;
  }
  return '';
}

export default function CreatorScreen() {
  const { address } = useParams<{ address: string }>();
  const [profile, setProfile] = useState<CreatorProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!address) return;
    fetch(`${API_URL}/api/marketplace/creator/${encodeURIComponent(address)}`, { signal: AbortSignal.timeout(10000) })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setProfile(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [address]);

  const shortAddr = (a: string) => `${a.slice(0, 10)}…${a.slice(-6)}`;

  return (
    <div className="mp-page">
      <TopNav />

      {loading ? (
        <div className="mp-empty"><div className="mp-spinner" /></div>
      ) : !profile || profile.collections.length === 0 ? (
        <div className="mp-empty" style={{ marginTop: 60 }}>No public collections from this creator.</div>
      ) : (
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '40px 24px' }}>
          {/* Header */}
          <div style={{ marginBottom: 36 }}>
            <div style={{ fontSize: 11, color: '#6b7280', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>Creator</div>
            <h1 style={{ fontSize: 22, fontWeight: 800, margin: '0 0 20px', fontFamily: 'monospace' }}>{shortAddr(profile.address)}</h1>
            <div style={{ display: 'flex', gap: 32 }}>
              <div>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{profile.collections.length}</div>
                <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Collections</div>
              </div>
              <div>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{profile.total_minted.toLocaleString()}</div>
                <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Minted</div>
              </div>
              {profile.total_revenue_mojo > 0 && (
                <div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: '#f97316' }}>{formatXch(profile.total_revenue_mojo)} XCH</div>
                  <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Volume</div>
                </div>
              )}
            </div>
          </div>

          <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 16px' }}>Collections</h2>
          <div className="mp-grid">
            {profile.collections.map(c => {
              const img = collImg(c);
              const pct = Math.min(100, Math.round((c.minted_count / Math.max(1, c.total_supply)) * 100));
              return (
                <a key={c.id} href={`/marketplace/${c.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                  <div className="mp-card">
                    <div className="mp-card-img">
                      {img
                        ? <img src={img} alt={c.name} onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                        : null}
                    </div>
                    <div className="mp-card-body">
                      <div className="mp-card-name">
                        {c.name}
                        {c.symbol && <span className="mp-symbol">{c.symbol}</span>}
                      </div>
                      <div className="mp-card-price">
                        {c.mint_price_mojo > 0 ? `${formatXch(c.mint_price_mojo)} XCH` : 'Free'}
                      </div>
                      <div className="mp-supply-bar">
                        <div className="mp-supply-fill" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="mp-card-foot">
                        <span>{c.minted_count.toLocaleString()} / {c.total_supply} minted</span>
                        <span className={`mp-badge mp-badge-${c.marketplace_status}`}>{c.marketplace_status}</span>
                      </div>
                    </div>
                  </div>
                </a>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
