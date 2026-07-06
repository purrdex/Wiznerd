import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { AreaChart, Area, XAxis, Tooltip, ResponsiveContainer } from 'recharts';
import './marketplace.css';
import { supabase } from '../lib/supabase';
import TopNav from '../components/TopNav';
import CartDrawer from './CartDrawer';
import { useCart } from './CartContext';

const API_URL   = (import.meta.env.VITE_API_URL   as string | undefined) || 'http://localhost:3002';
const PROXY_URL = (import.meta.env.VITE_PROXY_URL as string | undefined) || 'http://localhost:3001';

interface Collection {
  id: string; name: string; symbol: string; total_supply: number;
  mint_price_mojo: number; launch_at: string | null;
  marketplace_status: string; reveal_type: string;
  allowlist: string[]; mints_paused: boolean;
  creator_address: string | null; royalty_percent: number;
  ipfs_cid: string | null; minted_count: number; payment_address: string | null;
  description?: string; collection_image_url?: string; collection_image_path?: string;
  source?: string;
  creator_price_mojo?: number;
  platform_fee_mojo?: number;
}

interface GalleryItem {
  nft_id?: string | null;
  token_index: number | null; name?: string | null; metadata_uri?: string;
  traits?: Record<string, string>; image_cid?: string;
  image_url: string; buyer_address?: string | null;
  owner_puzzle_hash?: string | null;
  rarity_rank?: number | null;
}

interface NftOffer {
  id: string;
  offer_type: 'ask' | 'bid';
  price_mojo: number;
  price_token: string;
  maker_puzzle_hash: string | null;
  created_at: string;
  expires_at: string | null;
}

interface CatWallet {
  wallet_id: number;
  name: string;
  asset_id: string;
}

interface NftHistory {
  from: string | null;
  to: string | null;
  price_mojo: number | null;
  block_height: number | null;
  timestamp: string | null;
  type?: string;
}

interface ActivityEvent {
  event_type: 'sale' | 'transfer' | 'listing' | 'listing_cancelled' | 'offer';
  nft_id: string | null;
  nft_name: string | null;
  token_index: number | null;
  image_url: string | null;
  price_mojo: number | null;
  price_token: string;
  from_address: string | null;
  to_address: string | null;
  block_height: number | null;
  timestamp: string;
}

interface NftDetail {
  nft_id: string;
  owner_address: string | null;
  rarity_rank: number | null;
  rarity_score: number | null;
  traits: Record<string, string>;
  open_offers: NftOffer[];
  history: NftHistory[];
}

interface FloorItem {
  offer_id: string;
  nft_id: string;
  nft_name: string | null;
  image_url: string | null;
  price_mojo: number;
  price_token: string;
}

interface CollectionBid {
  id: string;
  collection_id: string;
  bidder_address: string;
  price_mojo: number;
  price_token: string;
  status: string;
  expires_at: string | null;
  created_at: string;
}


function formatXch(mojo: number): string {
  const v = Number(mojo) / 1e12;
  if (v === 0) return '0';
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (v >= 1)    return v.toFixed(2).replace(/\.?0+$/, '');
  return v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

// Format a price regardless of token type
// CAT amounts are stored in mojos (1 CAT = 1000 mojos for most CATs)
// but we display them as whole units (amount / 1000)
function formatTokenPrice(amount: number, token: string): string {
  if (token === 'xch') return `${formatXch(amount)} XCH`;
  // CAT mojos: most CATs use 1000 base units = 1 display unit
  const display = Number(amount) / 1000;
  return display % 1 === 0 ? `${display}` : display.toFixed(3).replace(/0+$/, '');
}

function tokenSymbol(token: string, catWallets: CatWallet[]): string {
  if (token === 'xch') return 'XCH';
  const cat = catWallets.find(c => c.asset_id === token);
  return cat ? cat.name.split(' ').pop() || cat.name : token.slice(0, 6) + '…';
}

function useCountdown(launchAt: string | null) {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    if (!launchAt) return;
    const tick = () => setMs(Math.max(0, new Date(launchAt).getTime() - Date.now()));
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [launchAt]);
  return ms;
}

function fmtCountdown(ms: number): string {
  if (ms <= 0) return 'Launching…';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h > 47) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

export default function CollectionScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const walletAddress = (() => { try { return localStorage.getItem('chia_primary_address') || ''; } catch { return ''; } })();

  const [coll, setColl] = useState<Collection | null>(null);
  const [gallery, setGallery] = useState<GalleryItem[]>([]);
  const [galleryCursor, setGalleryCursor] = useState<string | null>(null);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [traits, setTraits] = useState<Record<string, Record<string, number>>>({});
  const [traitsFilterable, setTraitsFilterable] = useState(false);
  const [selectedTraits, setSelectedTraits] = useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = useState<'gallery' | 'activity'>('gallery');
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityHasMore, setActivityHasMore] = useState(false);
  const [activityOffset, setActivityOffset] = useState(0);
  const [gallerySort, setGallerySort] = useState<'default' | 'rarity'>('default');
  const [gridSize, setGridSize] = useState<'large' | 'compact'>(() => {
    try { return (localStorage.getItem('mp_grid_size') as 'large' | 'compact') || 'large'; } catch { return 'large'; }
  });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedNft, setSelectedNft] = useState<GalleryItem | null>(null);
  const [nftDetail, setNftDetail] = useState<NftDetail | null>(null);
  const [nftDetailLoading, setNftDetailLoading] = useState(false);
  const [offerPanel, setOfferPanel] = useState<null | 'ask' | 'bid'>(null);
  const [offerPrice, setOfferPrice] = useState('');
  const [offerToken, setOfferToken] = useState('xch');
  const [catWallets, setCatWallets] = useState<CatWallet[]>([]);
  const [offerSubmitting, setOfferSubmitting] = useState(false);
  const [offerError, setOfferError] = useState<string | null>(null);
  const [takeTarget, setTakeTarget] = useState<NftOffer | null>(null);
  const [takePending, setTakePending] = useState(false);
  const [xchPrice, setXchPrice] = useState(0);
  const [mintedCount, setMintedCount] = useState(0);
  const [collStats, setCollStats] = useState<{
    indexed_count: number; unique_holders: number;
    floor_mojo: number | null; listed_count: number;
    volume_24h_mojo: number; volume_7d_mojo: number; volume_all_mojo: number;
    sales_24h: number; sales_7d: number; sales_all: number;
  } | null>(null);
  const [floorHistory, setFloorHistory] = useState<{ floor_price_mojo: number; snapshot_at: string }[]>([]);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [offerExpiry, setOfferExpiry] = useState('');
  const [cartOpen, setCartOpen] = useState(false);
  const [sweepOpen, setSweepOpen] = useState(false);
  const [floorItems, setFloorItems] = useState<FloorItem[]>([]);
  const [sweepCount, setSweepCount] = useState(3);
  const [sweepLoading, setSweepLoading] = useState(false);
  const [collBids, setCollBids] = useState<CollectionBid[]>([]);
  const [collBidPanel, setCollBidPanel] = useState(false);
  const [collBidPrice, setCollBidPrice] = useState('');
  const [collBidExpiry, setCollBidExpiry] = useState('');
  const [collBidSubmitting, setCollBidSubmitting] = useState(false);
  const [collBidError, setCollBidError] = useState<string | null>(null);
  const { addItem, hasItem } = useCart();

  const msLeft = useCountdown(coll?.launch_at ?? null);
  const isLive = coll?.marketplace_status === 'live' && (!coll.launch_at || msLeft <= 0);
  const isOnAllowlist = !coll?.allowlist?.length || (walletAddress && coll.allowlist.includes(walletAddress));

  const loadColl = useCallback(async () => {
    if (!id) return;
    try {
      const res = await fetch(`${API_URL}/api/marketplace/${id}`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return;
      const data: Collection = await res.json();
      setColl(data);
      setMintedCount(data.minted_count);
    } catch { /* ignore */ }
  }, [id]);

  const buildTraitsQuery = useCallback((traits: Record<string, string>) =>
    Object.keys(traits).length ? `traits=${encodeURIComponent(JSON.stringify(traits))}` : ''
  , []);

  const loadGallery = useCallback(async () => {
    if (!id) return;
    const tq = buildTraitsQuery(selectedTraits);
    const params = [tq, gallerySort !== 'default' ? `sort=${gallerySort}` : ''].filter(Boolean).join('&');
    const url = `${API_URL}/api/marketplace/${id}/gallery${params ? `?${params}` : ''}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return;
      const data = await res.json();
      const items: GalleryItem[] = Array.isArray(data) ? data : (data.items || []);
      setGallery(items);
      setGalleryCursor(data.next || null);
    } catch { /* ignore */ }
  }, [id, selectedTraits, gallerySort, buildTraitsQuery]);

  const loadMoreGallery = useCallback(async () => {
    if (!id || !galleryCursor || galleryLoading) return;
    setGalleryLoading(true);
    const tq = buildTraitsQuery(selectedTraits);
    const sortParam = gallerySort !== 'default' ? `sort=${gallerySort}` : '';
    const params = [`cursor=${encodeURIComponent(galleryCursor)}`, tq, sortParam].filter(Boolean).join('&');
    try {
      const res = await fetch(`${API_URL}/api/marketplace/${id}/gallery?${params}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return;
      const data = await res.json();
      setGallery(prev => [...prev, ...(data.items || [])]);
      setGalleryCursor(data.next || null);
    } catch { /* ignore */ }
    finally { setGalleryLoading(false); }
  }, [id, galleryCursor, galleryLoading, selectedTraits, gallerySort, buildTraitsQuery]);

  const loadTraits = useCallback(async () => {
    if (!id) return;
    try {
      const res = await fetch(`${API_URL}/api/marketplace/${id}/traits`, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const data = await res.json();
        setTraits(data.traits ?? data);
        setTraitsFilterable(data.filterable ?? false);
      }
    } catch { /* ignore */ }
  }, [id]);

  const loadPrice = useCallback(async () => {
    try {
      const r = await fetch(`${PROXY_URL}/price/xch`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) { const p = await r.json(); if (p.price) setXchPrice(p.price); }
    } catch { /* ignore */ }
  }, []);

  const loadFloorHistory = useCallback(async () => {
    if (!id) return;
    try {
      const r = await fetch(`${API_URL}/api/marketplace/${id}/floor-history?days=30`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) setFloorHistory(await r.json());
    } catch { /* ignore */ }
  }, [id]);

  const loadFloorItems = useCallback(async () => {
    if (!id) return;
    setSweepLoading(true);
    try {
      const r = await fetch(`${API_URL}/api/marketplace/${id}/floor-items?limit=20`, { signal: AbortSignal.timeout(10000) });
      if (r.ok) setFloorItems(await r.json());
    } catch { /* ignore */ }
    finally { setSweepLoading(false); }
  }, [id]);

  const loadCollBids = useCallback(async () => {
    if (!id) return;
    try {
      const r = await fetch(`${API_URL}/api/marketplace/${id}/collection-bids`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) setCollBids(await r.json());
    } catch { /* ignore */ }
  }, [id]);

  const loadCatWallets = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/api/wallet/cats`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) { const d = await r.json(); setCatWallets(d.cats || []); }
    } catch { /* wallet daemon may not be running */ }
  }, []);

  const loadActivity = useCallback(async (offset = 0) => {
    if (!id) return;
    setActivityLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/marketplace/collections/${id}/activity?offset=${offset}`, { signal: AbortSignal.timeout(12000) });
      if (res.ok) {
        const d = await res.json();
        const events: ActivityEvent[] = Array.isArray(d) ? d : (d.events ?? []);
        setActivity(prev => offset === 0 ? events : [...prev, ...events]);
        setActivityHasMore(Array.isArray(d) ? events.length >= 50 : (d.hasMore ?? false));
        setActivityOffset(offset + events.length);
      }
    } catch { /* ignore */ }
    finally { setActivityLoading(false); }
  }, [id]);

  function timeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1)   return 'just now';
    if (m < 60)  return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24)  return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 7)   return `${d}d ago`;
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function shortAddr(addr: string | null): string {
    if (!addr) return '—';
    return `${addr.slice(0, 8)}…${addr.slice(-5)}`;
  }

  function resetOfferPanel() {
    setOfferPanel(null); setOfferPrice(''); setOfferError(null); setOfferToken('xch'); setOfferExpiry('');
  }

  const reloadDetail = useCallback((nftId: string) => {
    fetch(`${API_URL}/api/nft/${encodeURIComponent(nftId)}`, { signal: AbortSignal.timeout(12000) })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setNftDetail(d); })
      .catch(() => {});
  }, []);

  // Load NFT detail when modal opens
  useEffect(() => {
    setHistoryExpanded(false);
    if (!selectedNft?.nft_id) { setNftDetail(null); return; }
    setNftDetail(null);
    setNftDetailLoading(true);
    fetch(`${API_URL}/api/nft/${encodeURIComponent(selectedNft.nft_id)}`, { signal: AbortSignal.timeout(12000) })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setNftDetail(d); })
      .catch(() => {})
      .finally(() => setNftDetailLoading(false));
  }, [selectedNft?.nft_id]);

  // One-time loads
  useEffect(() => { loadColl(); loadPrice(); loadTraits(); loadCatWallets(); loadFloorHistory(); loadCollBids(); }, [loadColl, loadPrice, loadTraits, loadCatWallets, loadFloorHistory, loadCollBids]);

  useEffect(() => {
    if (!id) return;
    fetch(`${API_URL}/api/marketplace/collections/${id}/stats`, { signal: AbortSignal.timeout(10000) })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setCollStats(d); })
      .catch(() => {});
  }, [id]);

  // Gallery reloads when traits or sort change
  useEffect(() => {
    setGallery([]);
    setGalleryCursor(null);
    loadGallery();
  }, [loadGallery]); // eslint-disable-line react-hooks/exhaustive-deps

  // Supabase Realtime — live supply counter
  useEffect(() => {
    if (!id) return;
    const ch = supabase.channel(`orders-${id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders', filter: `project_id=eq.${id}` },
        payload => {
          if (payload.new.status === 'confirmed') {
            setMintedCount(n => n + 1);
          }
        })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [id]);


  if (!coll) {
    return (
      <div className="mp-page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <div className="mp-spinner" />
      </div>
    );
  }

  const xch = formatXch(coll.mint_price_mojo);
  const pct = Math.min(100, Math.round((mintedCount / Math.max(1, coll.total_supply)) * 100));
  const traitCategories = Object.entries(traits);
  const activeTraitCount = Object.keys(selectedTraits).length;
  // Filtering works for wiznerd collections and external collections with ≥80% DB coverage
  const isIndexed = coll.source === 'wiznerd' || traitsFilterable;

  function toggleTrait(category: string, value: string) {
    setSelectedTraits(prev => {
      const next = { ...prev };
      if (next[category] === value) delete next[category]; else next[category] = value;
      return next;
    });
  }

  function expiryToIso(val: string): string | undefined {
    if (!val) return undefined;
    const hours = parseInt(val);
    if (!hours) return undefined;
    return new Date(Date.now() + hours * 3600000).toISOString();
  }

  return (
    <div className="mp-page">
      <TopNav onCartClick={() => setCartOpen(true)} />
      {cartOpen && <CartDrawer onClose={() => setCartOpen(false)} />}
      {coll.creator_address === walletAddress && (
        <div style={{ padding: '6px 24px', background: '#0f1016', borderBottom: '1px solid #1e2030' }}>
          <button className="mp-nav-link" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#f97316', fontSize: 13 }}
            onClick={() => navigate(`/marketplace/${id}/manage`)}>
            Manage this collection →
          </button>
        </div>
      )}

      {/* Hero image — prefer collection image, fall back to first generated token */}
      <div className="mp-hero">
        <img
          src={(() => {
            if (coll.collection_image_url) {
              return coll.collection_image_url.startsWith('ipfs://')
                ? `https://gateway.pinata.cloud/ipfs/${coll.collection_image_url.replace('ipfs://', '')}`
                : coll.collection_image_url;
            }
            if (coll.collection_image_path) {
              return `${API_URL.replace(':3002', ':3002')}/output/${id}/collection.png`;
            }
            return `${API_URL}/output/${id}/0.png`;
          })()}
          alt={coll.name}
          onError={e => {
            const img = e.target as HTMLImageElement;
            if (!img.src.includes('/0.png')) img.src = `${API_URL}/output/${id}/0.png`;
            else img.style.display = 'none';
          }}
        />
        <div className="mp-hero-overlay" />
      </div>

      {/* Body: meta + mint panel */}
      <div className="mp-collection-body">
        {/* Left: meta */}
        <div className="mp-coll-meta">
          <h2>{coll.name} <span className="mp-symbol">{coll.symbol}</span></h2>
          {coll.creator_address && (
            <div className="mp-coll-creator">
              Created by{' '}
              <Link to={`/marketplace/profile?address=${coll.creator_address}`} style={{ color: '#f97316', textDecoration: 'none' }}>
                {coll.creator_address.slice(0, 16)}…{coll.creator_address.slice(-8)}
              </Link>
            </div>
          )}
          {coll.description && (
            <p className="mp-coll-desc">{coll.description}</p>
          )}
          {coll.ipfs_cid && (
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16, fontFamily: 'monospace' }}>
              ipfs://{coll.ipfs_cid.slice(0, 30)}…
            </div>
          )}

          <div className="mp-stats">
            {coll.source === 'wiznerd' ? (
              <>
                <div className="mp-stat">
                  <div className="mp-stat-label">Supply</div>
                  <div className="mp-stat-val">{coll.total_supply}</div>
                </div>
                <div className="mp-stat">
                  <div className="mp-stat-label">Minted</div>
                  <div className="mp-stat-val">{mintedCount}</div>
                </div>
                <div className="mp-stat">
                  <div className="mp-stat-label">Royalties</div>
                  <div className="mp-stat-val">{coll.royalty_percent}%</div>
                </div>
                <div className="mp-stat">
                  <div className="mp-stat-label">Remaining</div>
                  <div className="mp-stat-val">{coll.total_supply - mintedCount}</div>
                </div>
              </>
            ) : (
              <>
                {coll.total_supply > 0 && (
                  <div className="mp-stat">
                    <div className="mp-stat-label">Supply</div>
                    <div className="mp-stat-val">{coll.total_supply.toLocaleString()}</div>
                  </div>
                )}
                {collStats && collStats.indexed_count > 0 && (
                  <div className="mp-stat">
                    <div className="mp-stat-label">Supply</div>
                    <div className="mp-stat-val">{collStats.indexed_count.toLocaleString()}</div>
                  </div>
                )}
                {collStats && collStats.unique_holders > 0 && (
                  <div className="mp-stat">
                    <div className="mp-stat-label">Holders</div>
                    <div className="mp-stat-val">{collStats.unique_holders.toLocaleString()}</div>
                  </div>
                )}
                {collStats?.floor_mojo != null ? (
                  <div className="mp-stat">
                    <div className="mp-stat-label">Floor</div>
                    <div className="mp-stat-val">
                      {formatXch(collStats.floor_mojo)} XCH
                      {collStats.sales_7d > 0 && collStats.volume_7d_mojo > 0 && (() => {
                        const avg7d = collStats.volume_7d_mojo / collStats.sales_7d;
                        const delta = ((collStats.floor_mojo - avg7d) / avg7d) * 100;
                        if (Math.abs(delta) < 1) return null;
                        const up = delta > 0;
                        return (
                          <span style={{ fontSize: 10, marginLeft: 4, color: up ? '#4ade80' : '#f87171' }}>
                            {up ? '↑' : '↓'}{Math.abs(delta).toFixed(0)}%
                          </span>
                        );
                      })()}
                    </div>
                  </div>
                ) : coll.mint_price_mojo > 0 && (
                  <div className="mp-stat">
                    <div className="mp-stat-label">Floor</div>
                    <div className="mp-stat-val">{formatXch(coll.mint_price_mojo)} XCH</div>
                  </div>
                )}
                {collStats && collStats.listed_count > 0 && (
                  <div className="mp-stat">
                    <div className="mp-stat-label">Listed</div>
                    <div className="mp-stat-val">{collStats.listed_count}</div>
                  </div>
                )}
                {collStats && collStats.volume_all_mojo > 0 && (
                  <div className="mp-stat">
                    <div className="mp-stat-label">XCH Vol</div>
                    <div className="mp-stat-val">{formatXch(collStats.volume_all_mojo)} XCH</div>
                  </div>
                )}
                {collStats && collStats.sales_all > 0 && (
                  <div className="mp-stat">
                    <div className="mp-stat-label">Sales</div>
                    <div className="mp-stat-val">{collStats.sales_all.toLocaleString()}</div>
                  </div>
                )}
                {collStats && collStats.volume_7d_mojo > 0 && (
                  <div className="mp-stat">
                    <div className="mp-stat-label">7d Vol</div>
                    <div className="mp-stat-val">{formatXch(collStats.volume_7d_mojo)} XCH</div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Floor price history chart — shown when snapshots exist */}
          {floorHistory.length >= 2 && (() => {
            const chartData = floorHistory.map(s => ({
              date: new Date(s.snapshot_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
              xch:  Math.round(s.floor_price_mojo / 1e9) / 1000,
            }));
            const first = chartData[0]?.xch ?? 0;
            const last  = chartData[chartData.length - 1]?.xch ?? 0;
            const pct   = first > 0 ? ((last - first) / first * 100) : 0;
            const up    = pct >= 0;
            return (
              <div style={{ marginTop: 20 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    Floor — 30d
                  </span>
                  {Math.abs(pct) >= 1 && (
                    <span style={{ fontSize: 11, color: up ? '#4ade80' : '#f87171' }}>
                      {up ? '↑' : '↓'}{Math.abs(pct).toFixed(0)}% 30d
                    </span>
                  )}
                </div>
                <ResponsiveContainer width="100%" height={64}>
                  <AreaChart data={chartData} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="floor-grad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor="#22d3ee" stopOpacity={0.25} />
                        <stop offset="95%" stopColor="#22d3ee" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="date" hide />
                    <Tooltip
                      contentStyle={{ background: '#111218', border: '1px solid #1e2030', borderRadius: 6, fontSize: 11 }}
                      labelStyle={{ color: '#94a3b8' }}
                      formatter={(v) => [`${v} XCH`, 'Floor']}
                    />
                    <Area type="monotone" dataKey="xch" stroke="#22d3ee" strokeWidth={1.5} fill="url(#floor-grad)" dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            );
          })()}
          {/* Collection bids */}
          {coll.source !== 'wiznerd' && (
            <div className="mp-coll-bids">
              <div className="mp-coll-bids-header">
                <span className="mp-coll-bids-title">Collection Offers{collBids.length > 0 && ` (${collBids.length})`}</span>
                {walletAddress && !collBidPanel && (
                  <button className="mp-coll-bid-btn" onClick={() => setCollBidPanel(true)}>+ Make Offer</button>
                )}
              </div>

              {collBidPanel && (
                <div className="mp-coll-bid-form">
                  <div className="mp-offer-price-row" style={{ marginBottom: 8 }}>
                    <input
                      className="mp-offer-price-input"
                      type="number" min="0" step="0.001" placeholder="Price (XCH)"
                      value={collBidPrice}
                      onChange={e => { setCollBidPrice(e.target.value); setCollBidError(null); }}
                    />
                    <select
                      className="mp-offer-token-select"
                      value={collBidExpiry}
                      onChange={e => setCollBidExpiry(e.target.value)}
                    >
                      <option value="">No expiry</option>
                      <option value="24">24h</option>
                      <option value="168">7 days</option>
                      <option value="720">30 days</option>
                    </select>
                  </div>
                  {collBidError && <div className="mp-offer-panel-error" style={{ marginBottom: 8 }}>{collBidError}</div>}
                  <div className="mp-offer-panel-actions">
                    <button
                      className="mp-nft-modal-btn"
                      disabled={collBidSubmitting || !collBidPrice}
                      onClick={async () => {
                        const priceMojo = Math.round(parseFloat(collBidPrice || '0') * 1e12);
                        if (!priceMojo) return;
                        setCollBidSubmitting(true); setCollBidError(null);
                        const expiresAt = collBidExpiry ? new Date(Date.now() + parseInt(collBidExpiry) * 3600000).toISOString() : null;
                        try {
                          const r = await fetch(`${API_URL}/api/marketplace/${id}/collection-bids`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ price_mojo: priceMojo, price_token: 'xch', bidder_address: walletAddress, expires_at: expiresAt }),
                            signal: AbortSignal.timeout(10000),
                          });
                          const d = await r.json();
                          if (!r.ok) { setCollBidError(d.error || 'Failed'); return; }
                          setCollBidPanel(false); setCollBidPrice(''); setCollBidExpiry('');
                          loadCollBids();
                        } catch { setCollBidError('Could not reach server'); }
                        finally { setCollBidSubmitting(false); }
                      }}
                    >
                      {collBidSubmitting ? 'Submitting…' : 'Submit Offer'}
                    </button>
                    <button className="mp-nft-modal-btn mp-nft-modal-btn-secondary" onClick={() => { setCollBidPanel(false); setCollBidError(null); }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {collBids.length > 0 ? (
                <div className="mp-coll-bid-list">
                  {collBids.map(bid => {
                    const isMyBid = bid.bidder_address === walletAddress;
                    return (
                      <div key={bid.id} className="mp-coll-bid-row">
                        <span className="mp-coll-bid-price">{formatXch(bid.price_mojo)} XCH</span>
                        <span className="mp-coll-bid-by" title={bid.bidder_address}>
                          {isMyBid ? 'You' : `${bid.bidder_address.slice(0, 8)}…`}
                        </span>
                        {bid.expires_at && (
                          <span className="mp-coll-bid-exp">
                            {timeAgo(bid.expires_at)} left
                          </span>
                        )}
                        {isMyBid ? (
                          <button className="mp-nft-modal-btn-sm mp-nft-modal-btn-cancel"
                            onClick={async () => {
                              await fetch(`${API_URL}/api/marketplace/collection-bids/${bid.id}`, { method: 'DELETE' });
                              loadCollBids();
                            }}>
                            Cancel
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: '#4b5563', padding: '8px 0' }}>No open offers for this collection.</div>
              )}
            </div>
          )}
        </div>

        {/* Right: mint panel or collection info */}
        <div className="mp-mint-panel">
          {coll.source !== 'wiznerd' && !coll.payment_address ? (
            /* External / indexed collection — show floor price info only */
            <>
              {Number(xch) > 0 ? (
                <>
                  <div className="mp-mint-price">{xch} XCH</div>
                  {xchPrice > 0 && (
                    <div className="mp-mint-price-usd">Floor ≈ ${(Number(xch) * xchPrice).toFixed(2)} USD</div>
                  )}
                </>
              ) : (
                <div className="mp-mint-price" style={{ fontSize: 20, color: '#94a3b8' }}>Chia NFT Collection</div>
              )}
              {coll.minted_count > 0 && (
                <>
                  <div className="mp-progress-bar" style={{ marginTop: 20 }}>
                    <div className="mp-progress-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mp-supply-text">{mintedCount} minted{coll.total_supply > 0 ? ` / ${coll.total_supply}` : ''}</div>
                </>
              )}
              <div style={{ marginTop: 20, padding: '14px 16px', background: '#0f1016', border: '1px solid #1e2030', borderRadius: 10, fontSize: 13, color: '#94a3b8', lineHeight: 1.6 }}>
                This collection lives on the Chia blockchain. Secondary market trading is available through Chia NFT wallets and exchanges.
              </div>
            </>
          ) : (
            /* Wiznerd-minted collection — full mint flow */
            <>
              <div className="mp-mint-price">
                {Number(xch) === 0 ? 'Free Mint' : `${xch} XCH`}
              </div>
              {xchPrice > 0 && Number(xch) > 0 && (
                <div className="mp-mint-price-usd">≈ ${(Number(xch) * xchPrice).toFixed(2)} USD</div>
              )}
              {coll.platform_fee_mojo != null && coll.platform_fee_mojo > 0 && coll.creator_price_mojo != null && (
                <div style={{ fontSize: 11, color: '#4b5563', marginTop: 6, lineHeight: 1.6 }}>
                  <span style={{ color: '#6b7280' }}>{formatXch(coll.creator_price_mojo)} XCH to creator</span>
                  {' + '}
                  <span style={{ color: '#f97316' }}>{formatXch(coll.platform_fee_mojo)} XCH platform fee</span>
                </div>
              )}

              <div className="mp-progress-bar">
                <div className="mp-progress-fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="mp-supply-text">{mintedCount} / {coll.total_supply} minted</div>

              {coll.allowlist?.length > 0 && isOnAllowlist && (
                <div className="mp-allowlist-badge">✓ Your address is on the allowlist</div>
              )}
              {coll.allowlist?.length > 0 && !isOnAllowlist && (
                <div className="mp-error-box" style={{ marginBottom: 12 }}>This is an allowlist-only mint. Your connected wallet is not on the list.</div>
              )}

              {coll.marketplace_status === 'sold_out' && (
                <div style={{ textAlign: 'center', padding: 16, color: '#94a3b8', fontSize: 15 }}>
                  Sold Out
                </div>
              )}

              {coll.mints_paused && coll.marketplace_status === 'live' && (
                <div style={{ textAlign: 'center', padding: 16, color: '#94a3b8', fontSize: 14 }}>
                  Minting is temporarily paused.
                </div>
              )}

              {coll.marketplace_status === 'scheduled' && coll.launch_at && msLeft > 0 && (
                <div className="mp-countdown">
                  <div className="mp-countdown-label">Launches in</div>
                  <div className="mp-countdown-time">{fmtCountdown(msLeft)}</div>
                </div>
              )}

              {isLive && !coll.mints_paused && coll.payment_address && (
                <div className="mp-payment">
                  <div className="mp-qr">
                    <QRCodeSVG value={coll.payment_address} size={160} fgColor="#e2e8f0" bgColor="#111218" style={{ borderRadius: 8 }} />
                  </div>
                  <div style={{ fontSize: 12, color: '#94a3b8', textAlign: 'center', margin: '8px 0 4px' }}>
                    Send {xch} XCH per NFT · multiples for bulk
                  </div>
                  <div
                    className="mp-payment-addr-input"
                    style={{ cursor: 'pointer', fontSize: 11, textAlign: 'center', padding: '10px 8px' }}
                    onClick={() => navigator.clipboard.writeText(coll.payment_address!)}
                    title="Click to copy"
                  >
                    {coll.payment_address}
                  </div>
                  <button className="mp-mint-btn" style={{ marginTop: 8 }} onClick={() => navigator.clipboard.writeText(coll.payment_address!)}>
                    Copy Address
                  </button>
                  <div style={{ fontSize: 11, color: '#4b5563', textAlign: 'center', marginTop: 8 }}>
                    NFT is automatically sent to the wallet that made the payment
                  </div>
                  <div style={{ marginTop: 12, padding: '10px 12px', background: '#0a0b0f', border: '1px solid #1e2030', borderRadius: 8, fontSize: 11, color: '#6b7280', lineHeight: 1.6, textAlign: 'center' }}>
                    No browser extension needed — works with any Chia wallet
                    <br />
                    <span style={{ color: '#4b5563' }}>Sage · Chia Light · Nucle · CLI</span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Tab bar */}
      <div className="mp-tab-bar">
        <button
          className={`mp-tab-btn${activeTab === 'gallery' ? ' active' : ''}`}
          onClick={() => setActiveTab('gallery')}
        >Items</button>
        <button
          className={`mp-tab-btn${activeTab === 'activity' ? ' active' : ''}`}
          onClick={() => { setActiveTab('activity'); setActivityOffset(0); loadActivity(0); }}
        >Activity</button>
      </div>

      {/* Activity feed */}
      {activeTab === 'activity' && (
        <div className="mp-activity">
          {activityLoading && activity.length === 0 ? (
            <div className="mp-empty"><div className="mp-spinner" /></div>
          ) : activity.length === 0 ? (
            <div className="mp-empty" style={{ padding: '40px 0' }}>No activity recorded yet.</div>
          ) : (
            <>
              {activity.map((ev, i) => {
                const label: Record<string, string> = {
                  sale: 'Sale', transfer: 'Transfer', listing: 'Listed',
                  listing_cancelled: 'Delisted', offer: 'Offer',
                };
                const color: Record<string, string> = {
                  sale: '#4ade80', transfer: '#22d3ee', listing: '#f97316',
                  listing_cancelled: '#6b7280', offer: '#a78bfa',
                };
                const displayName = ev.nft_name || (ev.token_index != null ? `#${ev.token_index + 1}` : ev.nft_id?.slice(0, 12) + '…' || '—');
                return (
                  <div key={`${ev.event_type}-${ev.nft_id ?? i}-${ev.timestamp}`} className="mp-activity-row">
                    <div className="mp-activity-thumb">
                      {ev.image_url
                        ? <img src={ev.image_url} alt={displayName} onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                        : <div className="mp-activity-thumb-ph" />}
                    </div>
                    <div className="mp-activity-name">{displayName}</div>
                    <div className="mp-activity-type" style={{ color: color[ev.event_type] || '#94a3b8' }}>
                      {label[ev.event_type] || ev.event_type}
                    </div>
                    <div className="mp-activity-price">
                      {ev.price_mojo != null
                        ? <>{formatXch(ev.price_mojo)} {ev.price_token === 'xch' ? 'XCH' : ev.price_token.slice(0, 6)}</>
                        : <span style={{ color: '#4b5563' }}>—</span>}
                    </div>
                    <div className="mp-activity-addrs">
                      {ev.from_address && <span title={ev.from_address || ''}>{shortAddr(ev.from_address)}</span>}
                      {ev.to_address   && <><span style={{ color: '#4b5563', margin: '0 4px' }}>→</span><span title={ev.to_address}>{shortAddr(ev.to_address)}</span></>}
                    </div>
                    <div className="mp-activity-time">{timeAgo(ev.timestamp)}</div>
                  </div>
                );
              })}
              {activityHasMore && (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '16px 0' }}>
                  <button
                    className="mp-load-more"
                    onClick={() => loadActivity(activityOffset)}
                    disabled={activityLoading}
                  >
                    {activityLoading ? 'Loading…' : 'Load More'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Trait filters */}
      {activeTab === 'gallery' && traitCategories.length > 0 && (
        <div className="mp-trait-panel">
          <div className="mp-trait-header">
            <button className="mp-trait-toggle" onClick={() => setFiltersOpen(o => !o)}>
              {filtersOpen ? '▲' : '▼'} {coll.source === 'wiznerd' ? 'Filters' : 'Traits'}
              {activeTraitCount > 0 && <span className="mp-trait-count">{activeTraitCount}</span>}
            </button>
            {activeTraitCount > 0 && isIndexed && (
              <button className="mp-trait-clear" onClick={() => setSelectedTraits({})}>Clear all</button>
            )}
            {!isIndexed && (
              <span className="mp-trait-info-note">Trait counts · filtering requires on-chain indexing</span>
            )}
          </div>
          {filtersOpen && (
            <div className="mp-trait-body">
              {traitCategories.map(([category, values]) => (
                <div key={category} className="mp-trait-row">
                  <div className="mp-trait-label">{category}</div>
                  <div className="mp-trait-pills">
                    {Object.entries(values)
                      .sort((a, b) => b[1] - a[1])
                      .map(([value, count]) => (
                        <button
                          key={value}
                          className={`mp-trait-pill${selectedTraits[category] === value ? ' active' : ''}${!isIndexed ? ' info-only' : ''}`}
                          onClick={() => isIndexed && toggleTrait(category, value)}
                        >
                          {value} <span className="mp-trait-pill-count">{count}</span>
                        </button>
                      ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Gallery */}
      {/* Sweep modal */}
      {sweepOpen && (
        <div className="mp-cart-overlay" onClick={() => setSweepOpen(false)}>
          <div className="mp-sweep-modal" onClick={e => e.stopPropagation()}>
            <div className="mp-cart-header">
              <span className="mp-cart-title">Sweep Floor</span>
              <button className="mp-cart-close" onClick={() => setSweepOpen(false)}>✕</button>
            </div>
            {sweepLoading ? (
              <div style={{ padding: 32, textAlign: 'center' }}><div className="mp-spinner" /></div>
            ) : floorItems.length === 0 ? (
              <div className="mp-cart-empty">No listed NFTs found for this collection.</div>
            ) : (
              <>
                <div style={{ padding: '12px 16px' }}>
                  <label style={{ fontSize: 12, color: '#94a3b8' }}>
                    Items to sweep: <strong style={{ color: '#e2e8f0' }}>{Math.min(sweepCount, floorItems.length)}</strong>
                  </label>
                  <input
                    type="range" min={1} max={Math.min(floorItems.length, 20)}
                    value={sweepCount} onChange={e => setSweepCount(parseInt(e.target.value))}
                    style={{ width: '100%', marginTop: 8 }}
                  />
                </div>
                <div className="mp-cart-items" style={{ maxHeight: 280 }}>
                  {floorItems.slice(0, sweepCount).map(item => (
                    <div key={item.offer_id} className="mp-cart-item">
                      <div className="mp-cart-item-img">
                        {item.image_url
                          ? <img src={item.image_url} alt="" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                          : <div className="mp-cart-item-ph" />}
                      </div>
                      <div className="mp-cart-item-info">
                        <div className="mp-cart-item-name">{item.nft_name || item.nft_id.slice(0, 14) + '…'}</div>
                        <div className="mp-cart-item-price">
                          {item.price_token === 'xch'
                            ? `${formatXch(item.price_mojo)} XCH`
                            : `${(item.price_mojo / 1000).toFixed(3).replace(/0+$/, '')}`}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mp-cart-footer">
                  {(() => {
                    const total = floorItems.slice(0, sweepCount).filter(i => i.price_token === 'xch').reduce((s, i) => s + i.price_mojo, 0);
                    return total > 0 ? <div className="mp-cart-total">Total: {formatXch(total)} XCH</div> : null;
                  })()}
                  <button className="mp-cart-btn" onClick={() => {
                    floorItems.slice(0, sweepCount).forEach(item => {
                      addItem({
                        offer_id: item.offer_id,
                        nft_id: item.nft_id,
                        nft_name: item.nft_name || item.nft_id.slice(0, 14),
                        image_url: item.image_url,
                        price_mojo: item.price_mojo,
                        price_token: item.price_token,
                        collection_id: id!,
                        collection_name: coll.name,
                      });
                    });
                    setSweepOpen(false);
                    setCartOpen(true);
                  }}>
                    Add {Math.min(sweepCount, floorItems.length)} to Cart
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {activeTab === 'gallery' && gallery.length > 0 && (
        <div className="mp-gallery">
          <div className="mp-gallery-header">
            <h3 style={{ margin: 0 }}>{coll.source === 'wiznerd' ? 'Recently Minted' : `Collection · ${gallery.length} shown`}</h3>
            <div className="mp-gallery-controls">
              {coll.source !== 'wiznerd' && collStats && (collStats.listed_count ?? 0) > 0 && (
                <button
                  className="mp-sweep-btn"
                  onClick={() => { setSweepCount(3); loadFloorItems(); setSweepOpen(true); }}
                >
                  Sweep Floor
                </button>
              )}
              {isIndexed && (
                <select
                  className="mp-gallery-sort"
                  value={gallerySort}
                  onChange={e => setGallerySort(e.target.value as 'default' | 'rarity')}
                >
                  <option value="default">Token order</option>
                  <option value="rarity">Rarity: rarest first</option>
                </select>
              )}
              <button
                className={`mp-grid-toggle${gridSize === 'large' ? ' active' : ''}`}
                onClick={() => { setGridSize('large'); localStorage.setItem('mp_grid_size', 'large'); }}
                title="Large grid"
              >⊞</button>
              <button
                className={`mp-grid-toggle${gridSize === 'compact' ? ' active' : ''}`}
                onClick={() => { setGridSize('compact'); localStorage.setItem('mp_grid_size', 'compact'); }}
                title="Compact grid"
              >⊟</button>
            </div>
          </div>
          <div className={`mp-gallery-grid${gridSize === 'compact' ? ' mp-gallery-grid-compact' : ''}`}>
            {gallery.map((item, i) => (
              <div key={item.nft_id || `t-${item.token_index ?? i}`} className="mp-gallery-item" onClick={() => setSelectedNft(item)} style={{ cursor: 'pointer' }}>
                {coll.reveal_type === 'revealed' || coll.reveal_type === 'instant' ? (
                  <img
                    src={item.image_url}
                    alt={item.name || `Token #${(item.token_index ?? i) + 1}`}
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                ) : (
                  <div style={{ width: '100%', aspectRatio: '1', background: 'linear-gradient(135deg, #1a1d26, #0f1016)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24 }}>
                    🔒
                  </div>
                )}
                {item.traits && Object.keys(item.traits).length > 0 && (
                  <div className="mp-gallery-traits">
                    {Object.entries(item.traits).slice(0, 6).map(([k, v]) => (
                      <div key={k} className="mp-gallery-trait-chip">
                        <span className="mp-gallery-trait-key">{k}</span>
                        <span className="mp-gallery-trait-val">{v}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mp-gallery-item-foot">
                  <span>{item.name || (item.token_index != null ? `#${item.token_index + 1}` : '')}</span>
                  {item.rarity_rank && <span className="mp-gallery-item-rank">#{item.rarity_rank}</span>}
                </div>
              </div>
            ))}
          </div>
          {galleryCursor && (
            <div style={{ textAlign: 'center', marginTop: 24 }}>
              <button
                className="mp-btn-secondary"
                onClick={loadMoreGallery}
                disabled={galleryLoading}
                style={{ minWidth: 140 }}
              >
                {galleryLoading ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </div>
      )}
      {/* NFT detail modal */}
      {selectedNft && (
        <div className="mp-nft-overlay" onClick={() => { setSelectedNft(null); setNftDetail(null); }}>
          <div className="mp-nft-modal" onClick={e => e.stopPropagation()}>
            <button className="mp-nft-close" onClick={() => { setSelectedNft(null); setNftDetail(null); }}>✕</button>
            <div className="mp-nft-modal-img">
              <img src={selectedNft.image_url} alt={selectedNft.name || ''} />
            </div>
            <div className="mp-nft-modal-info">
              <div className="mp-nft-modal-name">
                {selectedNft.name || nftDetail?.traits?.name || (selectedNft.token_index != null ? `#${selectedNft.token_index + 1}` : 'NFT')}
              </div>
              {selectedNft.token_index != null && selectedNft.name && (
                <div className="mp-nft-modal-index">Token #{selectedNft.token_index + 1}</div>
              )}

              {/* Owner + rarity row */}
              {(nftDetail?.owner_address || nftDetail?.rarity_rank) && (
                <div className="mp-nft-modal-meta">
                  {nftDetail.owner_address && (
                    <div className="mp-nft-modal-meta-row">
                      <span className="mp-nft-modal-meta-label">Owner</span>
                      <span className="mp-nft-modal-meta-value mp-nft-modal-addr" title={nftDetail.owner_address}>
                        {nftDetail.owner_address.slice(0, 10)}…{nftDetail.owner_address.slice(-6)}
                      </span>
                    </div>
                  )}
                  {nftDetail.rarity_rank && (
                    <div className="mp-nft-modal-meta-row">
                      <span className="mp-nft-modal-meta-label">Rarity</span>
                      <span className="mp-nft-modal-meta-value">
                        #{nftDetail.rarity_rank}
                        {coll.total_supply ? ` / ${coll.total_supply.toLocaleString()}` : ''}
                      </span>
                    </div>
                  )}
                </div>
              )}
              {nftDetailLoading && !nftDetail && (
                <div className="mp-nft-modal-loading">Loading details…</div>
              )}

              {/* Traits with rarity % */}
              {(() => {
                const traitMap = nftDetail?.traits && Object.keys(nftDetail.traits).length
                  ? nftDetail.traits
                  : (selectedNft.traits && Object.keys(selectedNft.traits).length ? selectedNft.traits : null);
                const total = collStats?.indexed_count || coll.total_supply || 0;
                return traitMap ? (
                  <div className="mp-nft-modal-traits">
                    {Object.entries(traitMap).map(([k, v]) => {
                      const count = traits[k]?.[v] ?? 0;
                      const pct = total > 0 && count > 0 ? (count / total * 100) : null;
                      return (
                        <div key={k} className="mp-nft-modal-trait">
                          <div className="mp-nft-modal-trait-label">{k}</div>
                          <div className="mp-nft-modal-trait-value">{v}</div>
                          {pct !== null && (
                            <div className="mp-nft-modal-trait-pct">{pct.toFixed(1)}%</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (!nftDetailLoading && (
                  <div style={{ color: '#4b5563', fontSize: 13, marginTop: 12 }}>
                    No trait data yet — run the NFT backfill to index this collection.
                  </div>
                ));
              })()}

              {/* Open offers */}
              {nftDetail?.open_offers && nftDetail.open_offers.length > 0 && (
                <div className="mp-nft-modal-offers">
                  <div className="mp-nft-modal-section-title">Open Offers</div>
                  {nftDetail.open_offers.map(o => {
                    const isOwnerOffer = nftDetail.owner_address === walletAddress;
                    const expiryMs = o.expires_at ? new Date(o.expires_at).getTime() - Date.now() : null;
                    const expiryLabel = expiryMs !== null
                      ? expiryMs <= 0 ? 'Expired' : timeAgo(o.expires_at!)
                      : null;
                    return (
                      <div key={o.id} className="mp-nft-modal-offer-row">
                        <span className="mp-nft-modal-offer-type">{o.offer_type === 'ask' ? 'Ask' : 'Bid'}</span>
                        <span className="mp-nft-modal-offer-price">
                          {formatTokenPrice(o.price_mojo, o.price_token || 'xch')}
                          {' '}{tokenSymbol(o.price_token || 'xch', catWallets)}
                        </span>
                        {(o.price_token === 'xch' || !o.price_token) && xchPrice > 0 && (
                          <span className="mp-nft-modal-offer-usd">
                            ${(Number(o.price_mojo) / 1e12 * xchPrice).toFixed(2)}
                          </span>
                        )}
                        {expiryLabel && (
                          <span style={{ fontSize: 10, color: expiryMs! <= 0 ? '#f87171' : '#6b7280' }}>
                            {expiryMs! <= 0 ? 'expired' : `exp ${expiryLabel}`}
                          </span>
                        )}
                        {isOwnerOffer ? (
                          <button className="mp-nft-modal-btn-sm mp-nft-modal-btn-cancel"
                            onClick={async () => {
                              await fetch(`${API_URL}/api/nft/offers/${o.id}`, { method: 'DELETE' });
                              if (selectedNft?.nft_id) reloadDetail(selectedNft.nft_id);
                            }}>
                            Cancel
                          </button>
                        ) : (
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button className="mp-nft-modal-btn-sm"
                              onClick={() => setTakeTarget(o)}>
                              {o.offer_type === 'ask' ? 'Buy' : 'Accept'}
                            </button>
                            {o.offer_type === 'ask' && walletAddress && (
                              <button
                                className={`mp-nft-modal-btn-sm${hasItem(o.id) ? ' mp-nft-modal-btn-cancel' : ''}`}
                                title={hasItem(o.id) ? 'In cart' : 'Add to cart'}
                                onClick={() => {
                                  if (!hasItem(o.id)) {
                                    addItem({
                                      offer_id: o.id,
                                      nft_id: selectedNft!.nft_id!,
                                      nft_name: selectedNft!.name || nftDetail?.traits?.name || `#${(selectedNft!.token_index ?? 0) + 1}`,
                                      image_url: selectedNft!.image_url || null,
                                      price_mojo: o.price_mojo,
                                      price_token: o.price_token || 'xch',
                                      collection_id: id!,
                                      collection_name: coll.name,
                                    });
                                    setCartOpen(true);
                                  }
                                }}
                              >
                                {hasItem(o.id) ? '✓' : '🛒'}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Transfer history */}
              {nftDetail?.history && nftDetail.history.length > 0 && (
                <div className="mp-nft-modal-history">
                  <div className="mp-nft-modal-section-title" style={{ display: 'flex', justifyContent: 'space-between' }}>
                    History
                    {nftDetail.history.length > 5 && (
                      <button
                        style={{ background: 'none', border: 'none', color: '#f97316', fontSize: 11, cursor: 'pointer' }}
                        onClick={() => setHistoryExpanded(e => !e)}
                      >
                        {historyExpanded ? 'Show less' : `View all ${nftDetail.history.length}`}
                      </button>
                    )}
                  </div>
                  {(historyExpanded ? nftDetail.history : nftDetail.history.slice(0, 5)).map((h, i) => (
                    <div key={i} className="mp-nft-modal-history-row">
                      <span className="mp-nft-modal-history-type">{h.type || (h.price_mojo ? 'Sale' : 'Transfer')}</span>
                      {h.price_mojo ? (
                        <span className="mp-nft-modal-history-price">{formatXch(h.price_mojo)} XCH</span>
                      ) : null}
                      {h.timestamp && (
                        <span className="mp-nft-modal-history-date">
                          {new Date(h.timestamp).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Action buttons */}
              {!offerPanel && !takeTarget && (() => {
                if (!walletAddress) {
                  return (
                    <div className="mp-nft-modal-actions">
                      <span style={{ fontSize: 12, color: '#4b5563' }}>
                        Open the wallet to buy, list, or make offers.
                      </span>
                      <button className="mp-nft-modal-btn mp-nft-modal-btn-secondary"
                        onClick={() => window.open('/', '_blank')}>
                        Open Wallet
                      </button>
                    </div>
                  );
                }
                const isOwner = !!nftDetail?.owner_address && nftDetail.owner_address === walletAddress;
                const existingAsk = nftDetail?.open_offers?.find(o => o.offer_type === 'ask');
                return (
                  <div className="mp-nft-modal-actions">
                    {isOwner ? (
                      !existingAsk && (
                        <button className="mp-nft-modal-btn" onClick={() => setOfferPanel('ask')}>
                          List for Sale
                        </button>
                      )
                    ) : (
                      existingAsk ? (
                        <button className="mp-nft-modal-btn" onClick={() => setTakeTarget(existingAsk)}>
                          Buy Now · {formatTokenPrice(existingAsk.price_mojo, existingAsk.price_token || 'xch')} {tokenSymbol(existingAsk.price_token || 'xch', catWallets)}
                        </button>
                      ) : null
                    )}
                    {!isOwner && (
                      <button className="mp-nft-modal-btn mp-nft-modal-btn-secondary"
                        onClick={() => setOfferPanel('bid')}>
                        Make Offer
                      </button>
                    )}
                  </div>
                );
              })()}

              {/* Offer creation panel */}
              {offerPanel && (() => {
                const isXch = offerToken === 'xch';
                const priceAmount = isXch
                  ? Math.round(parseFloat(offerPrice || '0') * 1e12)
                  : Math.round(parseFloat(offerPrice || '0') * 1000);
                const usd = isXch && xchPrice > 0 && priceAmount > 0
                  ? ` ≈ $${(priceAmount / 1e12 * xchPrice).toFixed(2)}`
                  : '';
                return (
                  <div className="mp-offer-panel">
                    <div className="mp-offer-panel-title">
                      {offerPanel === 'ask' ? 'List for Sale' : 'Make an Offer'}
                      <button className="mp-offer-panel-close" onClick={resetOfferPanel}>✕</button>
                    </div>
                    <p className="mp-offer-panel-hint">
                      {offerPanel === 'ask'
                        ? 'Set your asking price. The offer will be created using your local wallet and listed immediately.'
                        : 'Set the amount you want to offer for this NFT.'}
                    </p>
                    {offerPanel === 'ask' && (
                      <div style={{ fontSize: 11, color: '#f97316', marginBottom: 8 }}>
                        Listing fee: 0.001 XCH · paid to Wiznerd platform
                      </div>
                    )}
                    <div className="mp-offer-price-row">
                      <input
                        className="mp-offer-price-input"
                        type="number"
                        min="0"
                        step={isXch ? '0.001' : '1'}
                        placeholder={isXch ? '0.000' : '0'}
                        value={offerPrice}
                        onChange={e => { setOfferPrice(e.target.value); setOfferError(null); }}
                      />
                      <select
                        className="mp-offer-token-select"
                        value={offerToken}
                        onChange={e => { setOfferToken(e.target.value); setOfferPrice(''); setOfferError(null); }}
                      >
                        <option value="xch">XCH{usd}</option>
                        {catWallets.map(cat => (
                          <option key={cat.asset_id} value={cat.asset_id}>{cat.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="mp-offer-expiry-row">
                      <label style={{ fontSize: 11, color: '#6b7280' }}>Expires</label>
                      <select
                        className="mp-offer-token-select"
                        style={{ flex: 1 }}
                        value={offerExpiry}
                        onChange={e => setOfferExpiry(e.target.value)}
                      >
                        <option value="">Never</option>
                        <option value="1">1 hour</option>
                        <option value="6">6 hours</option>
                        <option value="24">24 hours</option>
                        <option value="168">7 days</option>
                        <option value="720">30 days</option>
                      </select>
                    </div>
                    {offerError && <div className="mp-offer-panel-error">{offerError}</div>}
                    <div className="mp-offer-panel-actions">
                      <button className="mp-nft-modal-btn"
                        disabled={offerSubmitting || !priceAmount}
                        onClick={async () => {
                          if (!selectedNft?.nft_id) return;
                          setOfferSubmitting(true); setOfferError(null);
                          try {
                            const r = await fetch(
                              `${API_URL}/api/nft/${encodeURIComponent(selectedNft.nft_id)}/create-offer`,
                              {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                  offer_type: offerPanel,
                                  price_mojo: priceAmount,
                                  token_id: offerToken,
                                  expires_at: expiryToIso(offerExpiry),
                                }),
                                signal: AbortSignal.timeout(35000),
                              }
                            );
                            const d = await r.json();
                            if (!r.ok) { setOfferError(d.error || 'Failed to create offer'); return; }
                            resetOfferPanel();
                            reloadDetail(selectedNft.nft_id);
                          } catch { setOfferError('Could not reach server'); }
                          finally { setOfferSubmitting(false); }
                        }}>
                        {offerSubmitting ? 'Creating…' : offerPanel === 'ask' ? 'List It' : 'Submit Offer'}
                      </button>
                      <button className="mp-nft-modal-btn mp-nft-modal-btn-secondary" onClick={resetOfferPanel}>
                        Cancel
                      </button>
                    </div>
                  </div>
                );
              })()}

              {/* Take offer confirmation */}
              {takeTarget && (
                <div className="mp-offer-panel">
                  <div className="mp-offer-panel-title">
                    {takeTarget.offer_type === 'ask' ? 'Confirm Purchase' : 'Accept Bid'}
                    <button className="mp-offer-panel-close" onClick={() => setTakeTarget(null)}>✕</button>
                  </div>
                  <p className="mp-offer-panel-hint">
                    {takeTarget.offer_type === 'ask'
                      ? <>You are buying <strong>{selectedNft?.name || 'this NFT'}</strong> for <strong>{formatTokenPrice(takeTarget.price_mojo, takeTarget.price_token || 'xch')} {tokenSymbol(takeTarget.price_token || 'xch', catWallets)}</strong>{(takeTarget.price_token === 'xch' || !takeTarget.price_token) && xchPrice > 0 ? ` ($${(Number(takeTarget.price_mojo) / 1e12 * xchPrice).toFixed(2)})` : ''}. This will submit the transaction to the Chia blockchain immediately.</>
                      : <>You are accepting a bid of <strong>{formatTokenPrice(takeTarget.price_mojo, takeTarget.price_token || 'xch')} {tokenSymbol(takeTarget.price_token || 'xch', catWallets)}</strong> for <strong>{selectedNft?.name || 'this NFT'}</strong>.</>
                    }
                  </p>
                  {offerError && <div className="mp-offer-panel-error">{offerError}</div>}
                  <div className="mp-offer-panel-actions">
                    <button className="mp-nft-modal-btn" disabled={takePending}
                      onClick={async () => {
                        setTakePending(true); setOfferError(null);
                        try {
                          const r = await fetch(`${API_URL}/api/nft/offers/${takeTarget.id}/take`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({}),
                            signal: AbortSignal.timeout(35000),
                          });
                          const d = await r.json();
                          if (!r.ok) { setOfferError(d.error || 'Transaction failed'); return; }
                          setTakeTarget(null);
                          if (selectedNft?.nft_id) reloadDetail(selectedNft.nft_id);
                        } catch (e: unknown) {
                          setOfferError(e instanceof Error ? e.message : 'Could not reach server');
                        } finally { setTakePending(false); }
                      }}>
                      {takePending ? 'Submitting…' : 'Confirm'}
                    </button>
                    <button className="mp-nft-modal-btn mp-nft-modal-btn-secondary"
                      onClick={() => { setTakeTarget(null); setOfferError(null); }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
