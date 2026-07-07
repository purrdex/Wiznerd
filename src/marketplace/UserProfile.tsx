import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import './marketplace.css';
import TopNav from '../components/TopNav';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:3002';

interface UserProfileData {
  address: string;
  display_name: string | null;
  bio: string | null;
  twitter_handle: string | null;
  website_url: string | null;
}

interface ProfileNft {
  nft_id: string | null;
  name: string | null;
  token_index: number | null;
  image_url: string | null;
  collection_id: string | null;
  rarity_rank: number | null;
}

interface ProfileCollection {
  id: string;
  name: string;
  thumbnail_url: string | null;
  count: number;
}

const EVENT_COLOR: Record<string, string> = {
  sale: '#4ade80', transfer: '#22d3ee', listing: '#f97316',
  listing_cancelled: '#6b7280', offer: '#a78bfa',
};
const EVENT_LABEL: Record<string, string> = {
  sale: 'Sale', transfer: 'Transfer', listing: 'Listed',
  listing_cancelled: 'Delisted', offer: 'Offer',
};
interface ActivityEvent {
  event_type: string; nft_id: string | null; nft_name: string | null;
  token_index: number | null; image_url: string | null;
  collection_id: string | null; collection_name: string | null;
  price_mojo: number | null; price_token: string;
  from_address: string | null; to_address: string | null; timestamp: string;
}

function shortAddrDisplay(addr: string) {
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`;
}
function fmtXch(mojo: number) {
  const v = mojo / 1e12;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return v.toFixed(v >= 1 ? 3 : 6).replace(/0+$/, '').replace(/\.$/, '');
}
function shortAddrFmt(addr: string | null) {
  if (!addr) return '—';
  return `${addr.slice(0, 8)}…${addr.slice(-5)}`;
}
function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 7 ? `${d}d ago` : new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function UserProfileScreen() {
  const { address } = useParams<{ address: string }>();
  const navigate = useNavigate();
  const ownAddress = (() => { try { return localStorage.getItem('chia_primary_address') || ''; } catch { return ''; } })();
  const isOwn = address === ownAddress;

  const [profile, setProfile] = useState<UserProfileData | null>(null);
  const [nfts, setNfts] = useState<ProfileNft[]>([]);
  const [collections, setCollections] = useState<ProfileCollection[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'nfts' | 'activity'>('nfts');
  const [activeCol, setActiveCol] = useState<string | null>(null);
  const [actEvents, setActEvents] = useState<ActivityEvent[]>([]);
  const [actLoading, setActLoading] = useState(false);
  const [actHasMore, setActHasMore] = useState(false);
  const [actOffset, setActOffset] = useState(0);

  // Edit state (own profile only)
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editBio, setEditBio] = useState('');
  const [editTwitter, setEditTwitter] = useState('');
  const [editWebsite, setEditWebsite] = useState('');
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!address) return;
    setLoading(true);

    // Sync the wallet daemon for this address: returns nft_ids only if the connected
    // wallet actually owns NFTs at this address (safe to call for any profile).
    const nftIdsPromise: Promise<string[] | null> = fetch(`${API_URL}/api/marketplace/profile/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address }),
      signal: AbortSignal.timeout(30000),
    })
      .then(r => r.ok ? r.json() : null)
      .then((d: { nft_ids?: string[] } | null) => d?.nft_ids?.length ? d.nft_ids : null)
      .catch(() => null);

    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    Promise.all([
      fetch(`${API_URL}/api/user-profile/${encodeURIComponent(address)}`, { signal: AbortSignal.timeout(8000) })
        .then(r => r.ok ? r.json() : { address }),
      nftIdsPromise.then((nftIds: string[] | null) =>
        fetch(`${API_URL}/api/marketplace/profile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address, nft_ids: nftIds || [] }),
          signal: AbortSignal.timeout(15000),
        }).then(r => r.ok ? r.json() : { nfts: [], collections: [] })
          .then(data => ({ data, nftIds }))
      ),
    ])
      .then(([prof, { data: nftData, nftIds }]) => {
        setProfile(prof);
        setEditName(prof.display_name || '');
        setEditBio(prof.bio || '');
        setEditTwitter(prof.twitter_handle || '');
        setEditWebsite(prof.website_url || '');
        setNfts(nftData.nfts || []);
        setCollections(nftData.collections || []);
        // If the wallet daemon returned nft_ids, phase 2 IPFS is running in the background.
        // Re-fetch the profile after 20s to pick up any newly resolved collection_ids.
        if (nftIds?.length) {
          refreshTimer = setTimeout(() => {
            fetch(`${API_URL}/api/marketplace/profile`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ address, nft_ids: nftIds }),
              signal: AbortSignal.timeout(15000),
            })
              .then(r => r.ok ? r.json() : null)
              .then(refreshed => {
                if (refreshed?.collections?.length) {
                  setNfts(refreshed.nfts || []);
                  setCollections(refreshed.collections || []);
                }
              })
              .catch(() => {});
          }, 20000);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    return () => { if (refreshTimer) clearTimeout(refreshTimer); };
  }, [address]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadActivity = useCallback(async (off: number) => {
    if (!address) return;
    setActLoading(true);
    try {
      const r = await fetch(`${API_URL}/api/marketplace/activity?address=${encodeURIComponent(address)}&offset=${off}`, { signal: AbortSignal.timeout(12000) });
      if (r.ok) {
        const d = await r.json();
        const evs: ActivityEvent[] = d.events ?? [];
        setActEvents(prev => off === 0 ? evs : [...prev, ...evs]);
        setActHasMore(d.hasMore ?? false);
        setActOffset(off + evs.length);
      }
    } catch { /* ignore */ }
    finally { setActLoading(false); }
  }, [address]);

  async function handleSave() {
    if (!address) return;
    setSaving(true);
    try {
      const r = await fetch(`${API_URL}/api/user-profile/${encodeURIComponent(address)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: editName, bio: editBio, twitter_handle: editTwitter, website_url: editWebsite }),
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) {
        const updated = await r.json();
        setProfile(updated);
        setEditing(false);
      }
    } catch { /* ignore */ }
    finally { setSaving(false); }
  }

  if (!address) return null;

  const avatarLetters = (profile?.display_name || address).slice(0, 2).toUpperCase();

  return (
    <div className="mp-page">
      <TopNav />

      {loading ? (
        <div className="mp-empty"><div className="mp-spinner" /></div>
      ) : (
        <div style={{ maxWidth: 1100, margin: '0 auto', padding: '40px 24px 64px' }}>

          {/* Profile header */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 24, marginBottom: 32, flexWrap: 'wrap' }}>
            <div className="mp-profile-avatar" style={{ width: 72, height: 72, fontSize: 24, flexShrink: 0 }}>
              {avatarLetters}
            </div>
            <div style={{ flex: 1, minWidth: 220 }}>
              {editing ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 480 }}>
                  <input className="wiz-nav-search" style={{ fontSize: 15, fontWeight: 700, maxWidth: '100%' }} placeholder="Display name" value={editName} onChange={e => setEditName(e.target.value)} />
                  <textarea
                    style={{ background: '#111218', border: '1px solid #2d2f3d', borderRadius: 8, color: '#e2e8f0', fontSize: 13, padding: '8px 12px', resize: 'vertical', minHeight: 64, outline: 'none', fontFamily: 'inherit' }}
                    placeholder="Bio" value={editBio} onChange={e => setEditBio(e.target.value)}
                  />
                  <input className="wiz-nav-search" style={{ maxWidth: '100%' }} placeholder="Twitter / X handle (no @)" value={editTwitter} onChange={e => setEditTwitter(e.target.value)} />
                  <input className="wiz-nav-search" style={{ maxWidth: '100%' }} placeholder="Website URL" value={editWebsite} onChange={e => setEditWebsite(e.target.value)} />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="mp-btn-primary" style={{ fontSize: 13 }} onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
                    <button className="mp-btn-secondary" style={{ fontSize: 13 }} onClick={() => setEditing(false)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
                    <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>
                      {profile?.display_name || shortAddrDisplay(address)}
                    </h1>
                    {isOwn && (
                      <button className="mp-btn-secondary" style={{ fontSize: 12, padding: '4px 12px' }} onClick={() => setEditing(true)}>
                        Edit Profile
                      </button>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                    <span style={{ fontSize: 12, color: '#4b5563', fontFamily: 'monospace' }}>{shortAddrDisplay(address)}</span>
                    <button
                      style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 13, padding: '0 2px' }}
                      onClick={() => { navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                      title="Copy address"
                    >
                      {copied ? '✓' : '⎘'}
                    </button>
                  </div>
                  {profile?.bio && <p style={{ margin: '0 0 8px', fontSize: 13, color: '#94a3b8', maxWidth: 480, lineHeight: 1.5 }}>{profile.bio}</p>}
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    {profile?.twitter_handle && (
                      <a href={`https://x.com/${profile.twitter_handle}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: '#60a5fa', display: 'flex', alignItems: 'center', gap: 4 }}>
                        𝕏 @{profile.twitter_handle}
                      </a>
                    )}
                    {profile?.website_url && (
                      <a href={profile.website_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: '#60a5fa' }}>
                        🌐 {profile.website_url.replace(/^https?:\/\//, '')}
                      </a>
                    )}
                  </div>
                </>
              )}
            </div>
            <div style={{ display: 'flex', gap: 24, flexShrink: 0, alignItems: 'flex-start' }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 22, fontWeight: 700 }}>{nfts.length}</div>
                <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>NFTs</div>
              </div>
              {collections.length > 0 && (
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 22, fontWeight: 700 }}>{collections.length}</div>
                  <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Collections</div>
                </div>
              )}
            </div>
          </div>

          {/* Tabs */}
          <div className="mp-tab-bar" style={{ marginBottom: 24 }}>
            <button className={`mp-tab-btn${activeTab === 'nfts' ? ' active' : ''}`} onClick={() => setActiveTab('nfts')}>
              NFTs {nfts.length > 0 && <span style={{ color: '#4b5563', marginLeft: 4, fontSize: 12 }}>{nfts.length}</span>}
            </button>
            <button className={`mp-tab-btn${activeTab === 'activity' ? ' active' : ''}`} onClick={() => { setActiveTab('activity'); if (actEvents.length === 0) loadActivity(0); }}>
              Activity
            </button>
          </div>

          {/* NFTs tab */}
          {activeTab === 'nfts' && (() => {
            const visible = activeCol ? nfts.filter(n => n.collection_id === activeCol) : nfts;
            const activeColName = activeCol ? (collections.find(c => c.id === activeCol)?.name || 'Collection') : null;
            return nfts.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px 0', color: '#4b5563' }}>
                <div style={{ fontSize: 36, marginBottom: 8 }}>🖼</div>
                <div style={{ fontSize: 15, color: '#94a3b8' }}>No indexed NFTs found for this address.</div>
              </div>
            ) : (
              <>
                {collections.length > 0 && (
                  <div className="mp-profile-filters" style={{ marginBottom: 20 }}>
                    <button
                      className={`mp-profile-filter-pill${!activeCol ? ' active' : ''}`}
                      onClick={() => setActiveCol(null)}
                    >
                      All <span className="mp-profile-filter-count">{nfts.length}</span>
                    </button>
                    {collections.map(c => (
                      <button
                        key={c.id}
                        className={`mp-profile-filter-pill${activeCol === c.id ? ' active' : ''}`}
                        onClick={() => setActiveCol(activeCol === c.id ? null : c.id)}
                      >
                        {c.thumbnail_url && <img src={c.thumbnail_url} alt="" className="mp-profile-filter-thumb" />}
                        {c.name}
                        <span className="mp-profile-filter-count">{c.count}</span>
                      </button>
                    ))}
                  </div>
                )}
                {visible.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '48px 24px', color: '#4b5563' }}>
                    No NFTs in {activeColName}.
                  </div>
                ) : (
                  <div className="mp-gallery-grid">
                    {visible.map((nft, i) => (
                      <div
                        key={nft.nft_id || i}
                        className="mp-gallery-item"
                        style={{ cursor: 'pointer' }}
                        onClick={() => nft.collection_id && navigate(`/marketplace/${nft.collection_id}${nft.nft_id ? `?nft=${encodeURIComponent(nft.nft_id)}` : ''}`)}
                      >
                        {nft.image_url
                          ? <img src={nft.image_url} alt={nft.name || ''} onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                          : <div style={{ aspectRatio: '1', background: '#0f1016' }} />}
                        <div className="mp-gallery-item-foot">
                          {nft.name || (nft.token_index != null ? `#${nft.token_index + 1}` : nft.nft_id?.slice(0, 10) + '…')}
                          {nft.rarity_rank && <span style={{ float: 'right', color: '#f97316', fontSize: 10 }}>#{nft.rarity_rank}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            );
          })()}

          {/* Activity tab */}
          {activeTab === 'activity' && (
            <div className="mp-activity mp-activity-global">
              {actLoading && actEvents.length === 0 ? (
                <div className="mp-empty"><div className="mp-spinner" /></div>
              ) : actEvents.length === 0 ? (
                <div className="mp-empty" style={{ padding: '60px 0' }}>No on-chain activity found.</div>
              ) : (
                <>
                  {actEvents.map((ev, i) => {
                    const displayName = ev.nft_name || (ev.token_index != null ? `#${ev.token_index + 1}` : ev.nft_id?.slice(0, 12) + '…' || '—');
                    return (
                      <div key={`${ev.event_type}-${ev.nft_id ?? i}-${ev.timestamp}`} className="mp-activity-row mp-activity-row-global">
                        <div className="mp-activity-thumb">
                          {ev.image_url
                            ? <img src={ev.image_url} alt={displayName} onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                            : <div className="mp-activity-thumb-ph" />}
                        </div>
                        <div className="mp-activity-nft-info">
                          <div className="mp-activity-name">{displayName}</div>
                          {ev.collection_id && (
                            <button className="mp-activity-col-link" onClick={() => navigate(`/marketplace/${ev.collection_id}`)}>
                              {ev.collection_name || ev.collection_id?.slice(0, 12) + '…'}
                            </button>
                          )}
                        </div>
                        <div className="mp-activity-type" style={{ color: EVENT_COLOR[ev.event_type] || '#94a3b8' }}>
                          {EVENT_LABEL[ev.event_type] || ev.event_type}
                        </div>
                        <div className="mp-activity-price">
                          {ev.price_mojo != null ? <>{fmtXch(ev.price_mojo)} {ev.price_token === 'xch' ? 'XCH' : ev.price_token.slice(0, 6)}</> : <span style={{ color: '#4b5563' }}>—</span>}
                        </div>
                        <div className="mp-activity-addrs">
                          {ev.from_address && <span title={ev.from_address}>{shortAddrFmt(ev.from_address)}</span>}
                          {ev.to_address && <><span style={{ color: '#4b5563', margin: '0 4px' }}>→</span><span title={ev.to_address}>{shortAddrFmt(ev.to_address)}</span></>}
                        </div>
                        <div className="mp-activity-time">{timeAgo(ev.timestamp)}</div>
                      </div>
                    );
                  })}
                  {actHasMore && (
                    <div style={{ display: 'flex', justifyContent: 'center', padding: '20px 0' }}>
                      <button className="mp-load-more" onClick={() => loadActivity(actOffset)} disabled={actLoading}>
                        {actLoading ? 'Loading…' : 'Load More'}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
