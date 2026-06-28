import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import './marketplace.css';
import { supabase } from '../lib/supabase';

const API_URL   = (import.meta.env.VITE_API_URL   as string | undefined) || 'http://localhost:3002';
const PROXY_URL = (import.meta.env.VITE_PROXY_URL as string | undefined) || 'http://localhost:3001';

interface Collection {
  id: string; name: string; symbol: string; total_supply: number;
  mint_price_mojo: number; launch_at: string | null;
  marketplace_status: string; reveal_type: string;
  allowlist: string[]; mints_paused: boolean;
  creator_address: string; royalty_percent: number;
  ipfs_cid: string; minted_count: number;
}

interface GalleryItem {
  id: string; buyer_address: string; confirmed_at: string; token_id: string;
  generated_tokens: { token_index: number; metadata_uri: string; traits: Record<string, string> };
}

type PayPhase = 'idle' | 'creating' | 'pending' | 'detected' | 'minting' | 'confirmed' | 'failed';
interface PayState {
  phase: PayPhase;
  orderId?: string;
  paymentAddress?: string;
  amountXch?: string;
  tokenIndex?: number;
  txId?: string;
  error?: string;
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
  const [xchPrice, setXchPrice] = useState(0);
  const [buyerAddr, setBuyerAddr] = useState(walletAddress);
  const [pay, setPay] = useState<PayState>({ phase: 'idle' });
  const [mintedCount, setMintedCount] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const msLeft = useCountdown(coll?.launch_at ?? null);
  const isLive = coll?.marketplace_status === 'live' && (!coll.launch_at || msLeft <= 0);
  const isOnAllowlist = !coll?.allowlist?.length || (walletAddress && coll.allowlist.includes(walletAddress));
  const canMint = isLive && !coll?.mints_paused && isOnAllowlist && pay.phase === 'idle';

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

  const loadGallery = useCallback(async () => {
    if (!id) return;
    try {
      const res = await fetch(`${API_URL}/api/marketplace/${id}/gallery`, { signal: AbortSignal.timeout(10000) });
      if (res.ok) setGallery(await res.json());
    } catch { /* ignore */ }
  }, [id]);

  const loadPrice = useCallback(async () => {
    try {
      const r = await fetch(`${PROXY_URL}/price/xch`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) { const p = await r.json(); if (p.price) setXchPrice(p.price); }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadColl();
    loadGallery();
    loadPrice();
  }, [loadColl, loadGallery, loadPrice]);

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

  // Poll order status after creating an order
  const startPolling = useCallback((orderId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${API_URL}/api/marketplace/${id}/orders/${orderId}`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return;
        const data = await res.json();
        const phase: PayPhase =
          data.status === 'pending_payment' ? 'pending'
          : data.status === 'payment_detected' ? 'detected'
          : data.status === 'minting' ? 'minting'
          : data.status === 'confirmed' ? 'confirmed'
          : data.status === 'failed' ? 'failed'
          : 'pending';

        setPay(prev => ({
          ...prev, phase,
          tokenIndex: data.generated_tokens?.token_index,
          txId: data.tx_id,
          error: data.status === 'failed' ? (data.tx_id || 'Mint failed') : undefined,
        }));

        if (phase === 'confirmed' || phase === 'failed') {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          if (phase === 'confirmed') { loadColl(); loadGallery(); }
        }
      } catch { /* ignore */ }
    }, 5000);
  }, [id, loadColl, loadGallery]);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  async function handleMint() {
    if (!id || !coll) return;
    setPay({ phase: 'creating' });
    try {
      const res = await fetch(`${API_URL}/api/marketplace/${id}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ buyer_address: buyerAddr || null }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create order');
      setPay({ phase: 'pending', orderId: data.order_id, paymentAddress: data.payment_address, amountXch: data.amount_xch });
      startPolling(data.order_id);
    } catch (e: unknown) {
      setPay({ phase: 'failed', error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (!coll) {
    return (
      <div className="mp-page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <div className="mp-spinner" />
      </div>
    );
  }

  const xch = formatXch(coll.mint_price_mojo);
  const pct = Math.min(100, Math.round((mintedCount / Math.max(1, coll.total_supply)) * 100));

  return (
    <div className="mp-page">
      {/* Nav */}
      <nav className="mp-nav">
        <a href="/" className="mp-nav-logo">Wiznerd<span>.</span></a>
        <a href="/marketplace" className="mp-nav-link">← Marketplace</a>
        {coll.creator_address === walletAddress && (
          <button className="mp-nav-link" style={{ background: 'none', border: 'none', cursor: 'pointer' }}
            onClick={() => navigate(`/marketplace/${id}/manage`)}>
            Manage →
          </button>
        )}
      </nav>

      {/* Hero image */}
      <div className="mp-hero">
        <img
          src={`${API_URL}/output/${id}/0.png`}
          alt={coll.name}
          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
        <div className="mp-hero-overlay" />
      </div>

      {/* Body: meta + mint panel */}
      <div className="mp-collection-body">
        {/* Left: meta */}
        <div className="mp-coll-meta">
          <h2>{coll.name} <span className="mp-symbol">{coll.symbol}</span></h2>
          <div className="mp-coll-creator">
            Created by <span>{coll.creator_address.slice(0, 16)}…{coll.creator_address.slice(-8)}</span>
          </div>
          {coll.ipfs_cid && (
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16, fontFamily: 'monospace' }}>
              ipfs://{coll.ipfs_cid.slice(0, 30)}…
            </div>
          )}

          <div className="mp-stats">
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
          </div>
        </div>

        {/* Right: mint panel */}
        <div className="mp-mint-panel">
          <div className="mp-mint-price">
            {Number(xch) === 0 ? 'Free Mint' : `${xch} XCH`}
          </div>
          {xchPrice > 0 && Number(xch) > 0 && (
            <div className="mp-mint-price-usd">≈ ${(Number(xch) * xchPrice).toFixed(2)} USD</div>
          )}

          <div className="mp-progress-bar">
            <div className="mp-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="mp-supply-text">{mintedCount} / {coll.total_supply} minted</div>

          {/* Allowlist badge */}
          {coll.allowlist?.length > 0 && isOnAllowlist && (
            <div className="mp-allowlist-badge">✓ Your address is on the allowlist</div>
          )}
          {coll.allowlist?.length > 0 && !isOnAllowlist && (
            <div className="mp-error-box" style={{ marginBottom: 12 }}>This is an allowlist-only mint. Your connected wallet is not on the list.</div>
          )}

          {/* Status: sold out */}
          {coll.marketplace_status === 'sold_out' && (
            <div style={{ textAlign: 'center', padding: 16, color: '#94a3b8', fontSize: 15 }}>
              🎉 Sold Out
            </div>
          )}

          {/* Status: paused */}
          {coll.mints_paused && coll.marketplace_status === 'live' && (
            <div style={{ textAlign: 'center', padding: 16, color: '#94a3b8', fontSize: 14 }}>
              Minting is temporarily paused.
            </div>
          )}

          {/* Countdown if scheduled */}
          {coll.marketplace_status === 'scheduled' && coll.launch_at && msLeft > 0 && (
            <div className="mp-countdown">
              <div className="mp-countdown-label">Launches in</div>
              <div className="mp-countdown-time">{fmtCountdown(msLeft)}</div>
            </div>
          )}

          {/* Idle: show mint button */}
          {pay.phase === 'idle' && (
            <div className="mp-payment">
              <input
                className="mp-payment-addr-input"
                placeholder="Your xch1 address (for NFT delivery)"
                value={buyerAddr}
                onChange={e => setBuyerAddr(e.target.value)}
              />
              <button className="mp-mint-btn" onClick={handleMint} disabled={!canMint}>
                {!isLive && coll.marketplace_status === 'scheduled' ? '⏳ Not Live Yet'
                  : coll.marketplace_status === 'sold_out' ? 'Sold Out'
                  : coll.allowlist?.length > 0 && !isOnAllowlist ? 'Not on Allowlist'
                  : coll.mints_paused ? 'Minting Paused'
                  : '⚡ Mint Now'}
              </button>
            </div>
          )}

          {/* Creating order */}
          {pay.phase === 'creating' && (
            <div className="mp-status-line">Creating order…</div>
          )}

          {/* Payment pending */}
          {(pay.phase === 'pending' || pay.phase === 'detected' || pay.phase === 'minting') && pay.paymentAddress && (
            <div className="mp-payment">
              <div className="mp-qr">
                <QRCodeSVG
                  value={`chia:${pay.paymentAddress}?amount=${pay.amountXch}`}
                  size={160} fgColor="#e2e8f0" bgColor="#111218"
                  style={{ borderRadius: 8 }}
                />
              </div>
              <div className="mp-payment-info">
                <div className="mp-payment-info-row">
                  <span className="mp-payment-info-label">Send exactly</span>
                  <span className="mp-payment-info-val" style={{ color: '#f97316', fontWeight: 700 }}>
                    {pay.amountXch} XCH
                  </span>
                </div>
                <div className="mp-payment-info-row">
                  <span className="mp-payment-info-label">To address</span>
                  <span className="mp-payment-info-val" style={{ fontSize: 10 }}>{pay.paymentAddress}</span>
                </div>
              </div>
              <div className="mp-status-line">
                <span className={`mp-status-dot ${pay.phase === 'minting' ? 'detected' : 'waiting'}`} />
                {pay.phase === 'pending' ? 'Waiting for payment…'
                  : pay.phase === 'detected' ? 'Payment detected — minting…'
                  : 'Minting your NFT…'}
              </div>
              <div style={{ fontSize: 11, color: '#4b5563', textAlign: 'center', marginTop: 8 }}>
                Checking every 10 seconds
              </div>
            </div>
          )}

          {/* Confirmed */}
          {pay.phase === 'confirmed' && (
            <div className="mp-confirmed-box">
              <div className="mp-confirmed-icon">🎉</div>
              <div className="mp-confirmed-text">NFT Minted!</div>
              {pay.tokenIndex !== undefined && (
                <div style={{ marginTop: 8 }}>
                  <div className="mp-nft-reveal">
                    {coll.reveal_type === 'blind' ? (
                      <div style={{ padding: '20px', background: '#1a1d26', borderRadius: 8, fontSize: 13, color: '#94a3b8' }}>
                        Blind mint — your NFT will be revealed when the creator unveils the collection.
                      </div>
                    ) : (
                      <img
                        src={`${API_URL}/output/${id}/${pay.tokenIndex}.png`}
                        alt={`Token #${pay.tokenIndex}`}
                        style={{ width: '100%', borderRadius: 8, display: 'block' }}
                      />
                    )}
                    <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 8 }}>
                      {coll.name} #{pay.tokenIndex! + 1}
                    </div>
                  </div>
                </div>
              )}
              <button className="mp-btn-secondary" style={{ marginTop: 16, width: '100%' }}
                onClick={() => setPay({ phase: 'idle' })}>
                Mint Another
              </button>
            </div>
          )}

          {/* Failed */}
          {pay.phase === 'failed' && (
            <div>
              <div className="mp-error-box">{pay.error || 'Something went wrong.'}</div>
              <button className="mp-mint-btn" onClick={() => setPay({ phase: 'idle' })}>Try Again</button>
            </div>
          )}
        </div>
      </div>

      {/* Gallery */}
      {gallery.length > 0 && (
        <div className="mp-gallery">
          <h3>Recently Minted</h3>
          <div className="mp-gallery-grid">
            {gallery.map(item => (
              <div key={item.id} className="mp-gallery-item">
                {coll.reveal_type === 'revealed' || coll.reveal_type === 'instant' ? (
                  <img
                    src={`${API_URL}/output/${id}/${item.generated_tokens?.token_index}.png`}
                    alt={`Token #${item.generated_tokens?.token_index}`}
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                ) : (
                  <div style={{ width: '100%', aspectRatio: '1', background: 'linear-gradient(135deg, #1a1d26, #0f1016)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24 }}>
                    🔒
                  </div>
                )}
                <div className="mp-gallery-item-foot">
                  #{(item.generated_tokens?.token_index ?? 0) + 1}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
