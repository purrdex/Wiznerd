import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import './marketplace.css';
import { supabase } from '../lib/supabase';
import TopNav from '../components/TopNav';

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
}

interface NftOffer {
  id: string;
  offer_type: 'ask' | 'bid';
  price_mojo: number;
  maker_puzzle_hash: string | null;
  created_at: string;
  expires_at: string | null;
}

interface NftHistory {
  from: string | null;
  to: string | null;
  price_mojo: number | null;
  block_height: number | null;
  timestamp: string | null;
  type?: string;
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


function formatXch(mojo: number): string {
  const v = Number(mojo) / 1e12;
  if (v === 0) return '0';
  return v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
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
  const [selectedTraits, setSelectedTraits] = useState<Record<string, string>>({});
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedNft, setSelectedNft] = useState<GalleryItem | null>(null);
  const [nftDetail, setNftDetail] = useState<NftDetail | null>(null);
  const [nftDetailLoading, setNftDetailLoading] = useState(false);
  const [offerPanel, setOfferPanel] = useState<null | 'ask' | 'bid'>(null);
  const [offerPrice, setOfferPrice] = useState('');
  const [offerSubmitting, setOfferSubmitting] = useState(false);
  const [offerError, setOfferError] = useState<string | null>(null);
  const [takeTarget, setTakeTarget] = useState<NftOffer | null>(null);
  const [takePending, setTakePending] = useState(false);
  const [xchPrice, setXchPrice] = useState(0);
  const [mintedCount, setMintedCount] = useState(0);
  const [collStats, setCollStats] = useState<{ indexed_count: number; unique_holders: number; floor_mojo: number | null; listed_count: number } | null>(null);

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
    const url = `${API_URL}/api/marketplace/${id}/gallery${tq ? `?${tq}` : ''}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return;
      const data = await res.json();
      const items: GalleryItem[] = Array.isArray(data) ? data : (data.items || []);
      setGallery(items);
      setGalleryCursor(data.next || null);
    } catch { /* ignore */ }
  }, [id, selectedTraits, buildTraitsQuery]);

  const loadMoreGallery = useCallback(async () => {
    if (!id || !galleryCursor || galleryLoading) return;
    setGalleryLoading(true);
    const tq = buildTraitsQuery(selectedTraits);
    const params = [`cursor=${encodeURIComponent(galleryCursor)}`, tq].filter(Boolean).join('&');
    try {
      const res = await fetch(`${API_URL}/api/marketplace/${id}/gallery?${params}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return;
      const data = await res.json();
      setGallery(prev => [...prev, ...(data.items || [])]);
      setGalleryCursor(data.next || null);
    } catch { /* ignore */ }
    finally { setGalleryLoading(false); }
  }, [id, galleryCursor, galleryLoading, selectedTraits, buildTraitsQuery]);

  const loadTraits = useCallback(async () => {
    if (!id) return;
    try {
      const res = await fetch(`${API_URL}/api/marketplace/${id}/traits`, { signal: AbortSignal.timeout(10000) });
      if (res.ok) setTraits(await res.json());
    } catch { /* ignore */ }
  }, [id]);

  const loadPrice = useCallback(async () => {
    try {
      const r = await fetch(`${PROXY_URL}/price/xch`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) { const p = await r.json(); if (p.price) setXchPrice(p.price); }
    } catch { /* ignore */ }
  }, []);

  function closeModal() {
    setSelectedNft(null); setNftDetail(null);
    setOfferPanel(null); setOfferPrice(''); setOfferError(null);
    setTakeTarget(null);
  }

  function resetOfferPanel() {
    setOfferPanel(null); setOfferPrice(''); setOfferError(null);
  }

  const reloadDetail = useCallback((nftId: string) => {
    fetch(`${API_URL}/api/nft/${encodeURIComponent(nftId)}`, { signal: AbortSignal.timeout(12000) })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setNftDetail(d); })
      .catch(() => {});
  }, []);

  // Load NFT detail when modal opens
  useEffect(() => {
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
  useEffect(() => { loadColl(); loadPrice(); loadTraits(); }, [loadColl, loadPrice, loadTraits]);

  useEffect(() => {
    if (!id) return;
    fetch(`${API_URL}/api/marketplace/collections/${id}/stats`, { signal: AbortSignal.timeout(10000) })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setCollStats(d); })
      .catch(() => {});
  }, [id]);

  // Gallery reloads when traits change (loadGallery dep includes selectedTraits)
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
  // Filtering works for wiznerd collections and any external collection indexed in our DB
  const isIndexed = coll.source === 'wiznerd' || gallery.some(g => g.traits && Object.keys(g.traits).length > 0);

  function toggleTrait(category: string, value: string) {
    setSelectedTraits(prev => {
      const next = { ...prev };
      if (next[category] === value) delete next[category]; else next[category] = value;
      return next;
    });
  }

  return (
    <div className="mp-page">
      <TopNav />
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
              Created by <span>{coll.creator_address.slice(0, 16)}…{coll.creator_address.slice(-8)}</span>
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
                    <div className="mp-stat-label">Indexed</div>
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
                    <div className="mp-stat-val">{formatXch(collStats.floor_mojo)} XCH</div>
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
              </>
            )}
          </div>
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
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Trait filters */}
      {traitCategories.length > 0 && (
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
      {gallery.length > 0 && (
        <div className="mp-gallery">
          <h3>{coll.source === 'wiznerd' ? 'Recently Minted' : `Collection · ${gallery.length} shown`}</h3>
          <div className="mp-gallery-grid">
            {gallery.map((item, i) => (
              <div key={item.token_index ?? `ext-${i}`} className="mp-gallery-item" onClick={() => setSelectedNft(item)} style={{ cursor: 'pointer' }}>
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
                  {item.name || (item.token_index != null ? `#${item.token_index + 1}` : '')}
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

              {/* Traits */}
              {(() => {
                const traitMap = nftDetail?.traits && Object.keys(nftDetail.traits).length
                  ? nftDetail.traits
                  : (selectedNft.traits && Object.keys(selectedNft.traits).length ? selectedNft.traits : null);
                return traitMap ? (
                  <div className="mp-nft-modal-traits">
                    {Object.entries(traitMap).map(([k, v]) => (
                      <div key={k} className="mp-nft-modal-trait">
                        <div className="mp-nft-modal-trait-label">{k}</div>
                        <div className="mp-nft-modal-trait-value">{v}</div>
                      </div>
                    ))}
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
                    return (
                      <div key={o.id} className="mp-nft-modal-offer-row">
                        <span className="mp-nft-modal-offer-type">{o.offer_type === 'ask' ? 'Ask' : 'Bid'}</span>
                        <span className="mp-nft-modal-offer-price">{formatXch(o.price_mojo)} XCH</span>
                        {xchPrice > 0 && (
                          <span className="mp-nft-modal-offer-usd">
                            ${(Number(o.price_mojo) / 1e12 * xchPrice).toFixed(2)}
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
                          <button className="mp-nft-modal-btn-sm"
                            onClick={() => setTakeTarget(o)}>
                            {o.offer_type === 'ask' ? 'Buy' : 'Accept'}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Transfer history */}
              {nftDetail?.history && nftDetail.history.length > 0 && (
                <div className="mp-nft-modal-history">
                  <div className="mp-nft-modal-section-title">History</div>
                  {nftDetail.history.slice(0, 5).map((h, i) => (
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
                          Buy Now · {formatXch(existingAsk.price_mojo)} XCH
                        </button>
                      ) : null
                    )}
                    {!isOwner && (
                      <button className="mp-nft-modal-btn mp-nft-modal-btn-secondary"
                        onClick={() => setOfferPanel('bid')}>
                        Make Offer
                      </button>
                    )}
                    {!nftDetail && !nftDetailLoading && (
                      <span style={{ fontSize: 12, color: '#4b5563' }}>
                        Connect wallet to buy or list
                      </span>
                    )}
                  </div>
                );
              })()}

              {/* Offer creation panel */}
              {offerPanel && (() => {
                const priceMojo = Math.round(parseFloat(offerPrice || '0') * 1e12);
                const usd = xchPrice > 0 && priceMojo > 0
                  ? ` ≈ $${(priceMojo / 1e12 * xchPrice).toFixed(2)}`
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
                        : 'Set the XCH amount you want to offer for this NFT.'}
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
                        step="0.001"
                        placeholder="0.000"
                        value={offerPrice}
                        onChange={e => { setOfferPrice(e.target.value); setOfferError(null); }}
                      />
                      <span className="mp-offer-price-unit">XCH{usd}</span>
                    </div>
                    {offerError && <div className="mp-offer-panel-error">{offerError}</div>}
                    <div className="mp-offer-panel-actions">
                      <button className="mp-nft-modal-btn"
                        disabled={offerSubmitting || !priceMojo}
                        onClick={async () => {
                          if (!selectedNft?.nft_id) return;
                          setOfferSubmitting(true); setOfferError(null);
                          try {
                            const r = await fetch(
                              `${API_URL}/api/nft/${encodeURIComponent(selectedNft.nft_id)}/create-offer`,
                              {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ offer_type: offerPanel, price_mojo: priceMojo }),
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
                      ? <>You are buying <strong>{selectedNft?.name || 'this NFT'}</strong> for <strong>{formatXch(takeTarget.price_mojo)} XCH</strong>{xchPrice > 0 ? ` ($${(Number(takeTarget.price_mojo) / 1e12 * xchPrice).toFixed(2)})` : ''}. This will submit the transaction to the Chia blockchain immediately.</>
                      : <>You are accepting a bid of <strong>{formatXch(takeTarget.price_mojo)} XCH</strong> for <strong>{selectedNft?.name || 'this NFT'}</strong>.</>
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
