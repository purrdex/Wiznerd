import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import './marketplace.css';
import TopNav from '../components/TopNav';
import CartDrawer from './CartDrawer';
import { useCart } from './CartContext';

const API_URL   = (import.meta.env.VITE_API_URL   as string | undefined) || 'http://localhost:3002';

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

interface ProfileNft {
  nft_id: string | null;
  name: string | null;
  token_index: number | null;
  image_url: string | null;
  traits: Record<string, string> | null;
  collection_id: string | null;
  rarity_rank: number | null;
}

interface CollectionBid {
  id: string;
  collection_id: string;
  bidder_address: string;
  price_mojo: number;
  price_token: string;
  expires_at: string | null;
  created_at: string;
  indexed_collections?: { name: string; thumbnail_url: string | null } | null;
}

interface ProfileCollection {
  id: string;
  name: string;
  thumbnail_uri: string | null;
  count: number;
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`;
}

function formatXch(mojo: number) {
  const v = mojo / 1e12;
  if (v === 0) return '0';
  if (v < 0.0001) return v.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  if (v < 1) return v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}


export default function ProfilePage() {
  const navigate = useNavigate();
  const [walletAddress, setWalletAddress] = useState(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('address') || localStorage.getItem('chia_primary_address') || '';
    } catch { return ''; }
  });

  const [nfts, setNfts] = useState<ProfileNft[]>([]);
  const [collections, setCollections] = useState<ProfileCollection[]>([]);
  const [activeCol, setActiveCol] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [xchMojo, setXchMojo] = useState<number | null>(null);
  const [selectedNft, setSelectedNft] = useState<ProfileNft | null>(null);
  const [copied, setCopied] = useState(false);
  const [listedNftIds, setListedNftIds] = useState<Set<string>>(new Set());
  const [profileTab, setProfileTab] = useState<'nfts' | 'bids' | 'activity'>('nfts');
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkListOpen, setBulkListOpen] = useState(false);
  const [bulkPrice, setBulkPrice] = useState('');
  const [bulkExpiry, setBulkExpiry] = useState('');
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'done'>('idle');
  const [bulkStatus, setBulkStatus] = useState<{ done: number; total: number; error?: string } | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [collBids, setCollBids] = useState<CollectionBid[]>([]);
  const [bidsLoading, setBidsLoading] = useState(false);
  const [actEvents, setActEvents] = useState<ActivityEvent[]>([]);
  const [actLoading, setActLoading] = useState(false);
  const [actHasMore, setActHasMore] = useState(false);
  const [actOffset, setActOffset] = useState(0);
  useCart(); // provides CartContext for CartDrawer and TopNav badge

  const loadActivity = useCallback(async (address: string, off: number) => {
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
  }, []);

  function loadProfile(address: string) {
    if (!address) { setLoading(false); return; }
    setLoading(true);
    setNfts([]); setCollections([]); setActiveCol(null); setXchMojo(null); setListedNftIds(new Set());

    // Always attempt sync — server verifies whether the requested address belongs
    // to the configured wallet and returns nft_ids only if it does. This lets
    // the owner's full profile show without needing a locally connected wallet.
    setSyncStatus('syncing');
    const syncPromise: Promise<string[] | null> = fetch(`${API_URL}/api/marketplace/profile/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address }),
      signal: AbortSignal.timeout(30000),
    })
      .then(r => r.ok ? r.json() : null)
      .then((d: { synced: number; total: number; nft_ids?: string[] } | null) => {
        if ((d?.synced ?? 0) > 0) setSyncStatus('done'); else setSyncStatus('idle');
        return d?.nft_ids?.length ? d.nft_ids : null;
      })
      .catch(() => { setSyncStatus('idle'); return null; });

    Promise.all([
      syncPromise.then((nftIds: string[] | null) => {
        // POST so nft_ids don't blow up the URL; server always also queries
        // by primary-address puzzle hash, so Meowfers + other-address NFTs merge
        return fetch(`${API_URL}/api/marketplace/profile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address, nft_ids: nftIds || [] }),
          signal: AbortSignal.timeout(15000),
        }).then(r => r.ok ? r.json() : { nfts: [], collections: [] });
      })
        .then(d => {
          const fetchedNfts: ProfileNft[] = d.nfts || [];
          setNfts(fetchedNfts); setCollections(d.collections || []);
          if (fetchedNfts.length) {
            const ids = fetchedNfts.map(n => n.nft_id).filter(Boolean).join(',');
            fetch(`${API_URL}/api/marketplace/offers/board?nft_ids=${encodeURIComponent(ids)}&page=0`, { signal: AbortSignal.timeout(10000) })
              .then(r => r.ok ? r.json() : { offers: [] })
              .then(od => setListedNftIds(new Set((od.offers || []).map((o: { nft_id: string }) => o.nft_id))))
              .catch(() => {});
          }
        }),

      (() => {
        // Own profile: use wallet-app balance (all derived addresses, stays fresh)
        try {
          const ownAddress = localStorage.getItem('chia_primary_address') || '';
          const cached = localStorage.getItem('chia_wallet_balance_mojo');
          if (cached && ownAddress && address.toLowerCase() === ownAddress.toLowerCase()) {
            setXchMojo(Number(cached));
            return Promise.resolve();
          }
        } catch { /* ignore */ }
        // External profile: query node for the single shown address
        return fetch(`${API_URL}/api/xch-balance?address=${encodeURIComponent(address)}`, {
          signal: AbortSignal.timeout(10000),
        }).then(r => r.ok ? r.json() : null)
          .then(d => { if (d?.balance_mojo != null) setXchMojo(Number(d.balance_mojo)); })
          .catch(() => {});
      })(),
    ])
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadProfile(walletAddress); }, [walletAddress]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!walletAddress) return;
    setBidsLoading(true);
    fetch(`${API_URL}/api/marketplace/collection-bids/for-owner/${encodeURIComponent(walletAddress)}`, { signal: AbortSignal.timeout(12000) })
      .then(r => r.ok ? r.json() : [])
      .then(d => setCollBids(d))
      .catch(() => {})
      .finally(() => setBidsLoading(false));
  }, [walletAddress]);

  function handleSwitch(newAddress: string) {
    setWalletAddress(newAddress);
    setSelectedNft(null);
  }

  function copy() {
    navigator.clipboard.writeText(walletAddress).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  const visible = activeCol
    ? nfts.filter(n => activeCol === '__other__' ? !n.collection_id : n.collection_id === activeCol)
    : nfts;
  const activeColName = activeCol ? (collections.find(c => c.id === activeCol)?.name || 'Collection') : null;

  if (!walletAddress) {
    return (
      <div className="mp-page">
        <TopNav onWalletSwitch={handleSwitch} />
        {cartOpen && <CartDrawer onClose={() => setCartOpen(false)} />}
        <div style={{ textAlign: 'center', padding: '80px 24px', color: '#4b5563' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🔑</div>
          <div style={{ fontSize: 18, color: '#94a3b8', marginBottom: 8 }}>No wallet connected</div>
          <div style={{ fontSize: 14, marginBottom: 24 }}>Import your mnemonic to see your NFTs and balance.</div>
          <button className="mp-btn-primary" onClick={() => navigate('/')}>Open Wallet</button>
        </div>
      </div>
    );
  }

  return (
    <div className="mp-page">
      {/* Nav */}
      <TopNav onWalletSwitch={handleSwitch} />
      {cartOpen && <CartDrawer onClose={() => setCartOpen(false)} />}

      {/* Profile header */}
      <div className="mp-profile-header">
        <div className="mp-profile-avatar">
          {walletAddress.slice(4, 6).toUpperCase()}
        </div>
        <div className="mp-profile-meta">
          <div className="mp-profile-addr">
            <span className="mp-profile-addr-text">{shortAddr(walletAddress)}</span>
            <button className="mp-profile-copy" onClick={copy} title="Copy address">
              {copied ? '✓' : '⎘'}
            </button>
            <a
              href={`/marketplace/profile/${walletAddress}`}
              style={{ marginLeft: 8, fontSize: 12, color: '#6b7280', textDecoration: 'none', padding: '2px 8px', border: '1px solid #2d2f3d', borderRadius: 12, transition: 'color 0.15s, border-color 0.15s' }}
              onMouseEnter={e => { (e.target as HTMLAnchorElement).style.color = '#f97316'; (e.target as HTMLAnchorElement).style.borderColor = '#f97316'; }}
              onMouseLeave={e => { (e.target as HTMLAnchorElement).style.color = '#6b7280'; (e.target as HTMLAnchorElement).style.borderColor = '#2d2f3d'; }}
              title="Edit public profile"
            >
              Edit profile →
            </a>
          </div>
          <div className="mp-profile-stats">
            {xchMojo != null && <span>{formatXch(xchMojo)} XCH</span>}
            {xchMojo != null && <span className="mp-profile-stats-sep">·</span>}
            <span>{nfts.length} NFT{nfts.length !== 1 ? 's' : ''}</span>
            {collections.length > 0 && (
              <><span className="mp-profile-stats-sep">·</span>
              <span>{collections.length} collection{collections.length !== 1 ? 's' : ''}</span></>
            )}
            {syncStatus === 'syncing' && (
              <><span className="mp-profile-stats-sep">·</span>
              <span style={{ color: '#6b7280', fontSize: 12 }}>syncing wallet…</span></>
            )}
            {syncStatus === 'done' && (
              <><span className="mp-profile-stats-sep">·</span>
              <span
                style={{ color: '#4ade80', fontSize: 12, cursor: 'pointer', textDecoration: 'underline' }}
                onClick={() => loadProfile(walletAddress)}
                title="New NFTs indexed — click to reload with collection grouping"
              >new NFTs indexed — refresh</span></>
            )}
          </div>
        </div>
      </div>

      {/* Collection filter pills */}
      {collections.length > 0 && (
        <div className="mp-profile-filters">
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
              {c.thumbnail_uri && (
                <img src={c.thumbnail_uri} alt="" className="mp-profile-filter-thumb" />
              )}
              {c.name}
              <span className="mp-profile-filter-count">{c.count}</span>
            </button>
          ))}
        </div>
      )}

      {/* Tab bar */}
      <div className="mp-tab-bar">
        <button className={`mp-tab-btn${profileTab === 'nfts' ? ' active' : ''}`} onClick={() => setProfileTab('nfts')}>
          My NFTs {nfts.length > 0 && <span style={{ color: '#4b5563', marginLeft: 4, fontSize: 12 }}>{nfts.length}</span>}
        </button>
        <button className={`mp-tab-btn${profileTab === 'activity' ? ' active' : ''}`} onClick={() => { setProfileTab('activity'); if (actEvents.length === 0) loadActivity(walletAddress, 0); }}>
          Activity
        </button>
        <button className={`mp-tab-btn${profileTab === 'bids' ? ' active' : ''}`} onClick={() => setProfileTab('bids')}>
          Collection Bids {collBids.length > 0 && <span style={{ color: '#f97316', marginLeft: 4, fontSize: 12 }}>{collBids.length}</span>}
        </button>
      </div>

      {/* NFTs tab */}
      {profileTab === 'nfts' && (
        <div className="mp-gallery" style={{ maxWidth: 1200, margin: '0 auto', padding: '0 24px 64px' }}>
          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
              <div className="mp-spinner" />
            </div>
          ) : visible.length === 0 ? (
            nfts.length === 0 ? (
              <div className="mp-profile-empty">
                <div className="mp-profile-empty-icon">🖼</div>
                <div className="mp-profile-empty-title">No indexed NFTs found</div>
                <div className="mp-profile-empty-sub">
                  NFTs appear here once their collection has been indexed.<br />
                  Browse the marketplace, open a collection, and the gallery will show your owned tokens.
                </div>
                <div className="mp-profile-empty-actions">
                  <button className="mp-btn-primary" onClick={() => window.location.href = '/marketplace'}>
                    Browse Marketplace
                  </button>
                  {xchMojo != null && xchMojo > 0 && (
                    <div style={{ alignSelf: 'center', color: '#94a3b8', fontSize: 13 }}>
                      Balance: {formatXch(xchMojo)} XCH
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '48px 24px', color: '#4b5563' }}>
                No NFTs in {activeColName}.
              </div>
            )
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                <h3 style={{ margin: 0 }}>
                  {activeColName || 'All NFTs'}
                  <span style={{ color: '#4b5563', fontWeight: 400, fontSize: 14, marginLeft: 8 }}>{visible.length}</span>
                </h3>
                <div style={{ display: 'flex', gap: 8 }}>
                  {selectMode && selectedIds.size > 0 && (
                    <button
                      className="mp-btn-primary"
                      style={{ fontSize: 12, padding: '6px 14px' }}
                      onClick={() => setBulkListOpen(true)}
                    >
                      List {selectedIds.size} NFTs
                    </button>
                  )}
                  <button
                    className="mp-btn-secondary"
                    style={{ fontSize: 12, padding: '6px 14px' }}
                    onClick={() => { setSelectMode(s => !s); setSelectedIds(new Set()); }}
                  >
                    {selectMode ? 'Cancel Select' : 'Select'}
                  </button>
                </div>
              </div>
              <div className="mp-gallery-grid">
                {visible.map((nft, i) => {
                  const isSelected = nft.nft_id ? selectedIds.has(nft.nft_id) : false;
                  return (
                    <div
                      key={nft.nft_id || i}
                      className={`mp-gallery-item${isSelected ? ' mp-gallery-item-selected' : ''}`}
                      onClick={() => {
                        if (selectMode && nft.nft_id) {
                          setSelectedIds(prev => {
                            const next = new Set(prev);
                            next.has(nft.nft_id!) ? next.delete(nft.nft_id!) : next.add(nft.nft_id!);
                            return next;
                          });
                        } else {
                          setSelectedNft(nft);
                        }
                      }}
                      style={{ cursor: 'pointer', position: 'relative' }}
                    >
                      {selectMode && (
                        <div className={`mp-gallery-select-check${isSelected ? ' checked' : ''}`}>
                          {isSelected ? '✓' : ''}
                        </div>
                      )}
                      {nft.image_url ? (
                        <img
                          src={nft.image_url}
                          alt={nft.name || ''}
                          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        />
                      ) : (
                        <div style={{ aspectRatio: '1', background: '#0f1016', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#2d2f3d', fontSize: 32 }}>?</div>
                      )}
                      {nft.nft_id && listedNftIds.has(nft.nft_id) && (
                        <div className="mp-gallery-listed-badge">Listed</div>
                      )}
                      {nft.traits && Object.keys(nft.traits).length > 0 && (
                        <div className="mp-gallery-traits">
                          {Object.entries(nft.traits).slice(0, 6).map(([k, v]) => (
                            <div key={k} className="mp-gallery-trait-chip">
                              <span className="mp-gallery-trait-key">{k}</span>
                              <span className="mp-gallery-trait-val">{v}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="mp-gallery-item-foot">
                        {nft.name || (nft.token_index != null ? `#${nft.token_index + 1}` : nft.nft_id?.slice(0, 10) + '…')}
                        {nft.rarity_rank && (
                          <span style={{ float: 'right', color: '#f97316', fontSize: 10 }}>#{nft.rarity_rank}</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* Bulk listing modal */}
          {bulkListOpen && (
            <div className="mp-cart-overlay" onClick={() => { setBulkListOpen(false); setBulkStatus(null); setBulkPrice(''); }}>
              <div className="mp-sweep-modal" onClick={e => e.stopPropagation()}>
                <div className="mp-cart-header">
                  <span className="mp-cart-title">List {selectedIds.size} NFTs</span>
                  <button className="mp-cart-close" onClick={() => { setBulkListOpen(false); setBulkStatus(null); setBulkPrice(''); }}>✕</button>
                </div>
                {bulkStatus ? (
                  <div className="mp-cart-log" style={{ padding: '16px' }}>
                    <div style={{ marginBottom: 8 }}>
                      {bulkStatus.done}/{bulkStatus.total} listed
                      {bulkStatus.error && <span style={{ color: '#f87171', marginLeft: 8 }}>{bulkStatus.error}</span>}
                    </div>
                    {bulkStatus.done === bulkStatus.total && (
                      <button className="mp-cart-btn" onClick={() => { setBulkListOpen(false); setBulkStatus(null); setBulkPrice(''); setSelectMode(false); setSelectedIds(new Set()); }}>
                        Done
                      </button>
                    )}
                  </div>
                ) : (
                  <div style={{ padding: '16px' }}>
                    <p style={{ fontSize: 13, color: '#94a3b8', margin: '0 0 12px' }}>
                      Set one price for all selected NFTs. Each will be listed via your local wallet.
                    </p>
                    <div className="mp-offer-price-row" style={{ marginBottom: 8 }}>
                      <input
                        className="mp-offer-price-input"
                        type="number" min="0" step="0.001" placeholder="Price (XCH)"
                        value={bulkPrice}
                        onChange={e => setBulkPrice(e.target.value)}
                      />
                      <span style={{ padding: '0 10px', color: '#94a3b8', fontSize: 13, alignSelf: 'center' }}>XCH each</span>
                    </div>
                    <div className="mp-offer-expiry-row" style={{ marginBottom: 12 }}>
                      <label style={{ fontSize: 11, color: '#6b7280' }}>Expires</label>
                      <select className="mp-offer-token-select" style={{ flex: 1 }} value={bulkExpiry} onChange={e => setBulkExpiry(e.target.value)}>
                        <option value="">Never</option>
                        <option value="24">24 hours</option>
                        <option value="168">7 days</option>
                        <option value="720">30 days</option>
                      </select>
                    </div>
                    <button
                      className="mp-cart-btn"
                      disabled={!bulkPrice}
                      onClick={async () => {
                        const priceMojo = Math.round(parseFloat(bulkPrice) * 1e12);
                        if (!priceMojo) return;
                        const expiresAt = bulkExpiry ? new Date(Date.now() + parseInt(bulkExpiry) * 3600000).toISOString() : undefined;
                        const ids = [...selectedIds];
                        setBulkStatus({ done: 0, total: ids.length });
                        let done = 0;
                        for (const nftId of ids) {
                          try {
                            const r = await fetch(`${API_URL}/api/nft/${encodeURIComponent(nftId)}/create-offer`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ offer_type: 'ask', price_mojo: priceMojo, token_id: 'xch', expires_at: expiresAt }),
                              signal: AbortSignal.timeout(35000),
                            });
                            if (!r.ok) { const d = await r.json(); setBulkStatus(s => s ? ({ ...s, error: d.error || 'failed' }) : s); }
                          } catch { setBulkStatus(s => s ? ({ ...s, error: 'network error' }) : s); }
                          done++;
                          setBulkStatus(s => s ? ({ ...s, done }) : s);
                        }
                      }}
                    >
                      List All Now
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Activity tab */}
      {profileTab === 'activity' && (
        <div className="mp-activity mp-activity-global" style={{ maxWidth: 900, margin: '0 auto', padding: '0 24px 64px' }}>
          {actLoading && actEvents.length === 0 ? (
            <div className="mp-empty"><div className="mp-spinner" /></div>
          ) : actEvents.length === 0 ? (
            <div className="mp-empty" style={{ padding: '60px 0' }}>No activity found for this address.</div>
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
                      {ev.price_mojo != null
                        ? <>{fmtXch(ev.price_mojo)} {ev.price_token === 'xch' ? 'XCH' : ev.price_token.slice(0, 6)}</>
                        : <span style={{ color: '#4b5563' }}>—</span>}
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
                  <button className="mp-load-more" onClick={() => loadActivity(walletAddress, actOffset)} disabled={actLoading}>
                    {actLoading ? 'Loading…' : 'Load More'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Collection Bids tab */}
      {profileTab === 'bids' && (
        <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 24px 64px' }}>
          {bidsLoading ? (
            <div style={{ textAlign: 'center', padding: 48 }}><div className="mp-spinner" /></div>
          ) : collBids.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '48px 24px', color: '#4b5563' }}>
              <div style={{ fontSize: 36, marginBottom: 8 }}>📭</div>
              <div style={{ fontSize: 15, color: '#94a3b8' }}>No collection offers yet.</div>
              <div style={{ fontSize: 13, marginTop: 6 }}>When someone makes a collection-level offer for an NFT you own, it appears here.</div>
            </div>
          ) : (
            <>
              <h3 style={{ marginBottom: 16, color: '#e2e8f0' }}>Open Collection Offers <span style={{ color: '#4b5563', fontWeight: 400, fontSize: 14 }}>({collBids.length})</span></h3>
              {collBids.map(bid => {
                const colName = bid.indexed_collections?.name || bid.collection_id.slice(0, 14) + '…';
                const colThumb = bid.indexed_collections?.thumbnail_url;
                return (
                  <div key={bid.id} className="mp-coll-bid-row" style={{ padding: '14px 0', borderBottom: '1px solid #1e2030' }}>
                    {colThumb && <img src={colThumb} alt="" style={{ width: 36, height: 36, borderRadius: 6, objectFit: 'cover', marginRight: 12, flexShrink: 0 }} />}
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, color: '#e2e8f0', marginBottom: 2 }}>{colName}</div>
                      <div style={{ fontSize: 11, color: '#6b7280' }}>
                        {bid.bidder_address.slice(0, 10)}… · {formatXch(bid.price_mojo)} XCH
                        {bid.expires_at && ` · expires ${new Date(bid.expires_at).toLocaleDateString()}`}
                      </div>
                    </div>
                    <span className="mp-coll-bid-price" style={{ margin: '0 12px' }}>{formatXch(bid.price_mojo)} XCH</span>
                    <button
                      className="mp-nft-modal-btn"
                      style={{ fontSize: 12, padding: '5px 12px' }}
                      onClick={() => navigate(`/marketplace/${bid.collection_id}`)}
                    >
                      View Collection →
                    </button>
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}

      {/* NFT detail modal */}
      {selectedNft && (
        <div className="mp-nft-overlay" onClick={() => setSelectedNft(null)}>
          <div className="mp-nft-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 680 }}>
            <button className="mp-nft-close" onClick={() => setSelectedNft(null)}>✕</button>
            <div className="mp-nft-modal-img" style={{ flex: '0 0 280px' }}>
              {selectedNft.image_url && (
                <img src={selectedNft.image_url} alt={selectedNft.name || ''} />
              )}
            </div>
            <div className="mp-nft-modal-info">
              <div className="mp-nft-modal-name">
                {selectedNft.name || (selectedNft.token_index != null ? `#${selectedNft.token_index + 1}` : 'NFT')}
              </div>
              {selectedNft.rarity_rank && (
                <div className="mp-nft-modal-index">
                  Rank #{selectedNft.rarity_rank}
                  {(() => {
                    const col = collections.find(c => c.id === selectedNft.collection_id);
                    return col ? ` · ${col.name}` : '';
                  })()}
                </div>
              )}
              {!selectedNft.rarity_rank && selectedNft.collection_id && (
                <div className="mp-nft-modal-index">
                  {collections.find(c => c.id === selectedNft.collection_id)?.name || ''}
                </div>
              )}

              {selectedNft.traits && Object.keys(selectedNft.traits).length > 0 ? (
                <div className="mp-nft-modal-traits">
                  {Object.entries(selectedNft.traits).map(([k, v]) => (
                    <div key={k} className="mp-nft-modal-trait">
                      <div className="mp-nft-modal-trait-label">{k}</div>
                      <div className="mp-nft-modal-trait-value">{v}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ color: '#4b5563', fontSize: 13, marginTop: 12 }}>No trait data indexed yet.</div>
              )}

              <div className="mp-nft-modal-actions">
                {selectedNft.collection_id && (
                  <button
                    className="mp-nft-modal-btn"
                    onClick={() => navigate(`/marketplace/${selectedNft.collection_id}`)}
                  >
                    View Collection →
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
