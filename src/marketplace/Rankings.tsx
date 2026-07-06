import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import './marketplace.css';
import TopNav from '../components/TopNav';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:3002';

interface RankedCollection {
  collection_id: string;
  name: string;
  thumbnail_url?: string | null;
  thumbnail_uri?: string | null;
  verified?: boolean;
  total_supply?: number;
  minted_count?: number;
  floor_price_mojo?: number | null;
  volume_24h_mojo?: number;
  volume_7d_mojo?: number;
  sales_24h?: number;
  sales_7d?: number;
  listed_count?: number;
  trending_score?: number;
  source?: string;
}

type SortKey = 'volume_7d' | 'volume_24h' | 'floor' | 'trending' | 'sales_7d';
const SORT_LABELS: Record<SortKey, string> = {
  volume_7d:  '7d Volume',
  volume_24h: '24h Volume',
  trending:   'Trending',
  floor:      'Floor Price',
  sales_7d:   '7d Sales',
};

function formatXch(mojo: number | null | undefined): string {
  if (!mojo) return '—';
  const v = mojo / 1e12;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  if (v >= 1)    return v.toFixed(2);
  return v.toFixed(4).replace(/0+$/, '');
}

export default function RankingsPage() {
  const navigate = useNavigate();
  const [sort, setSort]         = useState<SortKey>('volume_7d');
  const [collections, setCollections] = useState<RankedCollection[]>([]);
  const [loading, setLoading]   = useState(true);

  const load = useCallback(async (s: SortKey) => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/marketplace/rankings?sort=${s}&limit=100`, {
        signal: AbortSignal.timeout(12000),
      });
      if (res.ok) setCollections(await res.json());
    } catch { /* server not running */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(sort); }, [load, sort]);

  function thumb(c: RankedCollection): string {
    return c.thumbnail_url || c.thumbnail_uri || '';
  }

  return (
    <div className="mp-page">
      <TopNav activePath="/marketplace/rankings" />

      <div className="mp-hero-bar">
        <div className="mp-hero-inner">
          <h1>Rankings</h1>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(Object.keys(SORT_LABELS) as SortKey[]).map(s => (
              <button
                key={s}
                className={`mp-filter-btn${sort === s ? ' active' : ''}`}
                onClick={() => setSort(s)}
              >
                {SORT_LABELS[s]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="mp-empty"><div className="mp-spinner" /></div>
      ) : collections.length === 0 ? (
        <div className="mp-empty">No ranking data yet — check back after collections have trading activity.</div>
      ) : (
        <div className="mp-rankings-wrap">
          <table className="mp-rankings-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Collection</th>
                <th className="mp-rank-r">Floor</th>
                <th className="mp-rank-r">24h Vol</th>
                <th className={`mp-rank-r${sort === 'volume_7d' ? ' mp-rank-active-col' : ''}`}>7d Vol</th>
                <th className="mp-rank-r">24h Sales</th>
                <th className={`mp-rank-r${sort === 'sales_7d' ? ' mp-rank-active-col' : ''}`}>7d Sales</th>
                <th className="mp-rank-r">Listed</th>
                <th className="mp-rank-r">Supply</th>
              </tr>
            </thead>
            <tbody>
              {collections.map((c, i) => (
                <tr
                  key={c.collection_id}
                  className="mp-rank-row"
                  onClick={() => navigate(`/marketplace/${c.collection_id}`)}
                >
                  <td className="mp-rank-num">{i + 1}</td>
                  <td>
                    <div className="mp-rank-col-cell">
                      {thumb(c) ? (
                        <img
                          src={thumb(c)}
                          alt={c.name}
                          className="mp-rank-thumb"
                          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        />
                      ) : (
                        <div className="mp-rank-thumb mp-rank-thumb-ph" />
                      )}
                      <span className="mp-rank-name">
                        {c.name}
                        {c.verified && <span className="mp-verified-badge" title="Verified">✓</span>}
                      </span>
                    </div>
                  </td>
                  <td className="mp-rank-r">{formatXch(c.floor_price_mojo)} {c.floor_price_mojo ? 'XCH' : ''}</td>
                  <td className="mp-rank-r">{formatXch(c.volume_24h_mojo)} {(c.volume_24h_mojo ?? 0) > 0 ? 'XCH' : ''}</td>
                  <td className={`mp-rank-r${sort === 'volume_7d' ? ' mp-rank-active-col' : ''}`}>
                    {formatXch(c.volume_7d_mojo)} {(c.volume_7d_mojo ?? 0) > 0 ? 'XCH' : ''}
                  </td>
                  <td className="mp-rank-r">{c.sales_24h ?? 0}</td>
                  <td className={`mp-rank-r${sort === 'sales_7d' ? ' mp-rank-active-col' : ''}`}>{c.sales_7d ?? 0}</td>
                  <td className="mp-rank-r">{c.listed_count ?? 0}</td>
                  <td className="mp-rank-r">{(c.minted_count ?? c.total_supply ?? 0).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
