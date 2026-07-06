import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import './marketplace.css';
import TopNav from '../components/TopNav';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:3002';

interface ActivityEvent {
  event_type: string;
  nft_id: string | null;
  nft_name: string | null;
  token_index: number | null;
  image_url: string | null;
  collection_id: string | null;
  collection_name: string | null;
  collection_thumb: string | null;
  price_mojo: number | null;
  price_token: string;
  from_address: string | null;
  to_address: string | null;
  timestamp: string;
}

type TypeFilter = 'all' | 'sale' | 'transfer' | 'listing' | 'offer';
const TYPE_LABELS: Record<TypeFilter, string> = {
  all: 'All', sale: 'Sales', transfer: 'Transfers', listing: 'Listings', offer: 'Offers',
};

const EVENT_COLOR: Record<string, string> = {
  sale: '#4ade80', transfer: '#22d3ee', listing: '#f97316',
  listing_cancelled: '#6b7280', offer: '#a78bfa',
};
const EVENT_LABEL: Record<string, string> = {
  sale: 'Sale', transfer: 'Transfer', listing: 'Listed',
  listing_cancelled: 'Delisted', offer: 'Offer',
};

function formatXch(mojo: number): string {
  const v = mojo / 1e12;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return v.toFixed(v >= 1 ? 3 : 6).replace(/0+$/, '').replace(/\.$/, '');
}

function shortAddr(addr: string | null): string {
  if (!addr) return '—';
  return `${addr.slice(0, 8)}…${addr.slice(-5)}`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7)  return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function ActivityPage() {
  const navigate = useNavigate();
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [events, setEvents]         = useState<ActivityEvent[]>([]);
  const [loading, setLoading]       = useState(true);
  const [hasMore, setHasMore]       = useState(false);
  const [offset, setOffset]         = useState(0);

  const load = useCallback(async (type: TypeFilter, off: number) => {
    setLoading(true);
    try {
      const res = await fetch(
        `${API_URL}/api/marketplace/activity?type=${type}&offset=${off}`,
        { signal: AbortSignal.timeout(12000) }
      );
      if (res.ok) {
        const d = await res.json();
        const evs: ActivityEvent[] = d.events ?? [];
        setEvents(prev => off === 0 ? evs : [...prev, ...evs]);
        setHasMore(d.hasMore ?? false);
        setOffset(off + evs.length);
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { setOffset(0); load(typeFilter, 0); }, [load, typeFilter]);

  return (
    <div className="mp-page">
      <TopNav activePath="/marketplace/activity" />

      <div className="mp-hero-bar">
        <div className="mp-hero-inner">
          <h1>Activity</h1>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(Object.keys(TYPE_LABELS) as TypeFilter[]).map(t => (
              <button
                key={t}
                className={`mp-filter-btn${typeFilter === t ? ' active' : ''}`}
                onClick={() => setTypeFilter(t)}
              >
                {TYPE_LABELS[t]}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mp-activity mp-activity-global">
        {loading && events.length === 0 ? (
          <div className="mp-empty"><div className="mp-spinner" /></div>
        ) : events.length === 0 ? (
          <div className="mp-empty" style={{ padding: '60px 0' }}>No activity yet.</div>
        ) : (
          <>
            {events.map((ev, i) => {
              const displayName = ev.nft_name || (ev.token_index != null ? `#${ev.token_index + 1}` : ev.nft_id?.slice(0, 12) + '…' || '—');
              return (
                <div key={`${ev.event_type}-${ev.nft_id ?? i}-${ev.timestamp}`} className="mp-activity-row mp-activity-row-global">
                  {/* NFT thumb */}
                  <div className="mp-activity-thumb">
                    {ev.image_url
                      ? <img src={ev.image_url} alt={displayName} onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                      : <div className="mp-activity-thumb-ph" />}
                  </div>

                  {/* NFT info */}
                  <div className="mp-activity-nft-info">
                    <div className="mp-activity-name">{displayName}</div>
                    {ev.collection_id && (
                      <button
                        className="mp-activity-col-link"
                        onClick={e => { e.stopPropagation(); navigate(`/marketplace/${ev.collection_id}`); }}
                      >
                        {ev.collection_thumb && (
                          <img src={ev.collection_thumb} alt="" className="mp-activity-col-thumb"
                            onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                        )}
                        {ev.collection_name || ev.collection_id?.slice(0, 12) + '…'}
                      </button>
                    )}
                  </div>

                  <div className="mp-activity-type" style={{ color: EVENT_COLOR[ev.event_type] || '#94a3b8' }}>
                    {EVENT_LABEL[ev.event_type] || ev.event_type}
                  </div>

                  <div className="mp-activity-price">
                    {ev.price_mojo != null
                      ? <>{formatXch(ev.price_mojo)} {ev.price_token === 'xch' ? 'XCH' : ev.price_token.slice(0, 6)}</>
                      : <span style={{ color: '#4b5563' }}>—</span>}
                  </div>

                  <div className="mp-activity-addrs">
                    {ev.from_address && <span title={ev.from_address}>{shortAddr(ev.from_address)}</span>}
                    {ev.to_address   && <><span style={{ color: '#4b5563', margin: '0 4px' }}>→</span><span title={ev.to_address}>{shortAddr(ev.to_address)}</span></>}
                  </div>

                  <div className="mp-activity-time">{timeAgo(ev.timestamp)}</div>
                </div>
              );
            })}

            {hasMore && (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '20px 0' }}>
                <button className="mp-load-more" onClick={() => load(typeFilter, offset)} disabled={loading}>
                  {loading ? 'Loading…' : 'Load More'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
