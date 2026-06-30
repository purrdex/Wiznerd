import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import './marketplace.css';
import TopNav from '../components/TopNav';

const API_URL   = (import.meta.env.VITE_API_URL   as string | undefined) || 'http://localhost:3002';
const PROXY_URL = (import.meta.env.VITE_PROXY_URL as string | undefined) || 'http://localhost:3001';

interface ProfileNft {
  nft_id: string | null;
  name: string | null;
  token_index: number | null;
  image_url: string | null;
  traits: Record<string, string> | null;
  collection_id: string | null;
  rarity_rank: number | null;
}

interface ProfileCollection {
  id: string;
  name: string;
  thumbnail_uri: string | null;
  count: number;
}

interface StoredWallet {
  id: string;
  name: string;
  primaryAddress?: string;
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`;
}

function formatXch(mojo: number) {
  return (mojo / 1e12).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function WalletSwitcher({ onSwitch }: { onSwitch: (address: string) => void }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [wallets, setWallets] = useState<StoredWallet[]>([]);
  const [activeId, setActiveId] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      setWallets(JSON.parse(localStorage.getItem('chia_wallets') || '[]'));
      setActiveId(localStorage.getItem('chia_active_wallet') || '');
    } catch {}
  }, []);

  const active = wallets.find(w => w.id === activeId);
  const activeAddr = (() => { try { return localStorage.getItem('chia_primary_address') || ''; } catch { return ''; } })();

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  function switchTo(w: StoredWallet) {
    setOpen(false);
    if (w.id === activeId) return;
    if (!w.primaryAddress) {
      // Address not yet cached — send to wallet to unlock, then return here
      localStorage.setItem('chia_active_wallet', w.id);
      sessionStorage.setItem('chia_return_url', '/marketplace/profile');
      navigate('/');
      return;
    }
    localStorage.setItem('chia_active_wallet', w.id);
    localStorage.setItem('chia_primary_address', w.primaryAddress);
    setActiveId(w.id);
    onSwitch(w.primaryAddress);
  }

  if (!wallets.length) return null;

  return (
    <div className="mp-wallet-switcher" ref={ref}>
      <button className="mp-wallet-btn" onClick={() => setOpen(o => !o)}>
        <span className="mp-wallet-btn-dot" />
        <span className="mp-wallet-btn-name">{active?.name || 'My Wallet'}</span>
        {activeAddr && <span className="mp-wallet-btn-addr">{shortAddr(activeAddr)}</span>}
        <span className="mp-wallet-btn-caret">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="mp-wallet-dropdown">
          {wallets.map(w => (
            <button
              key={w.id}
              className={`mp-wallet-dropdown-item${w.id === activeId ? ' active' : ''}`}
              onClick={() => switchTo(w)}
            >
              <div>
                <div className="mp-wallet-dropdown-name">{w.name}</div>
                {w.primaryAddress && (
                  <div style={{ fontSize: 10, color: '#4b5563', fontFamily: 'monospace' }}>
                    {shortAddr(w.primaryAddress)}
                  </div>
                )}
              </div>
              {w.id === activeId
                ? <span className="mp-wallet-dropdown-check">✓</span>
                : !w.primaryAddress && <span style={{ fontSize: 10, color: '#4b5563' }}>unlock first</span>
              }
            </button>
          ))}
          <div className="mp-wallet-dropdown-divider" />
          <button className="mp-wallet-dropdown-item mp-wallet-dropdown-settings"
            onClick={() => { setOpen(false); navigate('/'); }}>
            Manage wallets →
          </button>
        </div>
      )}
    </div>
  );
}

export default function ProfilePage() {
  const navigate = useNavigate();
  const [walletAddress, setWalletAddress] = useState(
    () => { try { return localStorage.getItem('chia_primary_address') || ''; } catch { return ''; } }
  );

  const [nfts, setNfts] = useState<ProfileNft[]>([]);
  const [collections, setCollections] = useState<ProfileCollection[]>([]);
  const [activeCol, setActiveCol] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [xchMojo, setXchMojo] = useState<number | null>(null);
  const [selectedNft, setSelectedNft] = useState<ProfileNft | null>(null);
  const [copied, setCopied] = useState(false);
  const [listedNftIds, setListedNftIds] = useState<Set<string>>(new Set());

  function loadProfile(address: string) {
    if (!address) { setLoading(false); return; }
    setLoading(true);
    setNfts([]); setCollections([]); setActiveCol(null); setXchMojo(null); setListedNftIds(new Set());

    Promise.all([
      fetch(`${API_URL}/api/marketplace/profile?address=${encodeURIComponent(address)}`, { signal: AbortSignal.timeout(15000) })
        .then(r => r.ok ? r.json() : { nfts: [], collections: [] })
        .then(d => {
          const fetchedNfts: ProfileNft[] = d.nfts || [];
          setNfts(fetchedNfts); setCollections(d.collections || []);
          // Check which NFTs have open asks
          if (fetchedNfts.length) {
            const ids = fetchedNfts.map(n => n.nft_id).filter(Boolean).join(',');
            fetch(`${API_URL}/api/marketplace/offers/board?nft_ids=${encodeURIComponent(ids)}&page=0`, { signal: AbortSignal.timeout(10000) })
              .then(r => r.ok ? r.json() : { offers: [] })
              .then(od => setListedNftIds(new Set((od.offers || []).map((o: { nft_id: string }) => o.nft_id))))
              .catch(() => {});
          }
        }),

      fetch(`${PROXY_URL}/wallet/get_wallet_balance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet_id: 1 }),
        signal: AbortSignal.timeout(8000),
      }).then(r => r.ok ? r.json() : null)
        .then(d => { if (d?.wallet_balance?.confirmed_wallet_balance != null) setXchMojo(d.wallet_balance.confirmed_wallet_balance); })
        .catch(() => {}),
    ])
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadProfile(walletAddress); }, [walletAddress]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const visible = activeCol ? nfts.filter(n => n.collection_id === activeCol) : nfts;
  const activeColName = activeCol ? (collections.find(c => c.id === activeCol)?.name || 'Collection') : null;

  if (!walletAddress) {
    return (
      <div className="mp-page">
        <TopNav onWalletSwitch={handleSwitch} />
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
          </div>
          <div className="mp-profile-stats">
            {xchMojo != null && <span>{formatXch(xchMojo)} XCH</span>}
            {xchMojo != null && <span className="mp-profile-stats-sep">·</span>}
            <span>{nfts.length} NFT{nfts.length !== 1 ? 's' : ''}</span>
            {collections.length > 0 && (
              <><span className="mp-profile-stats-sep">·</span>
              <span>{collections.length} collection{collections.length !== 1 ? 's' : ''}</span></>
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

      {/* Gallery */}
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
            <h3 style={{ marginBottom: 16 }}>
              {activeColName || 'All NFTs'}
              <span style={{ color: '#4b5563', fontWeight: 400, fontSize: 14, marginLeft: 8 }}>{visible.length}</span>
            </h3>
            <div className="mp-gallery-grid">
              {visible.map((nft, i) => (
                <div
                  key={nft.nft_id || i}
                  className="mp-gallery-item"
                  onClick={() => setSelectedNft(nft)}
                  style={{ cursor: 'pointer' }}
                >
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
              ))}
            </div>
          </>
        )}
      </div>

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
