import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import './marketplace.css';

const API_URL   = (import.meta.env.VITE_API_URL   as string | undefined) || 'http://localhost:3002';
const PROXY_URL = (import.meta.env.VITE_PROXY_URL as string | undefined) || 'http://localhost:3001';

interface BoardOffer {
  offer_id: string;
  nft_id: string;
  price_mojo: number;
  created_at: string;
  expires_at: string | null;
  name: string | null;
  token_index: number | null;
  image_url: string | null;
  rarity_rank: number | null;
  collection_id: string | null;
  collection_name: string;
  thumbnail_uri: string | null;
}

type SortKey = 'price' | 'rarity' | 'recent';

function formatXch(mojo: number) {
  const v = Number(mojo) / 1e12;
  return v.toLocaleString(undefined, { maximumFractionDigits: 6, minimumFractionDigits: 3 });
}

function nftLabel(o: BoardOffer) {
  return o.name || (o.token_index != null ? `#${o.token_index + 1}` : o.nft_id.slice(0, 10) + '…');
}

export default function OffersPage() {
  const navigate = useNavigate();
  const [offers, setOffers] = useState<BoardOffer[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<SortKey>('price');
  const [loading, setLoading] = useState(true);
  const [xchPrice, setXchPrice] = useState(0);
  const [takingId, setTakingId] = useState<string | null>(null);
  const [takeMsg, setTakeMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `${API_URL}/api/marketplace/offers/board?sort=${sort}&page=${page}`,
        { signal: AbortSignal.timeout(15000) }
      );
      if (!res.ok) throw new Error(await res.text());
      const d = await res.json();
      setOffers(d.offers || []);
      setTotal(d.total || 0);
    } catch { setOffers([]); }
    finally { setLoading(false); }
  }, [sort, page]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    fetch(`${PROXY_URL}/price/xch`, { signal: AbortSignal.timeout(5000) })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.price) setXchPrice(d.price); })
      .catch(() => {});
  }, []);

  async function takeOffer(offerId: string) {
    setTakingId(offerId);
    setTakeMsg(null);
    try {
      const res = await fetch(`${API_URL}/api/nft/offers/${offerId}/take`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(30000),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Take failed');
      setTakeMsg('Purchase submitted!');
      load();
    } catch (e: unknown) {
      setTakeMsg((e as Error).message);
    } finally {
      setTakingId(null);
    }
  }

  const perPage = 48;
  const totalPages = Math.ceil(total / perPage);

  return (
    <div className="mp-page">
      <nav className="mp-nav">
        <a href="/" className="mp-nav-logo">Wiznerd<span>.</span></a>
        <a href="/marketplace" className="mp-nav-link">← Marketplace</a>
        <a href="/marketplace/offers" className="mp-nav-link active">Offer Board</a>
        <a href="/marketplace/profile" className="mp-nav-link">My NFTs</a>
      </nav>

      <div className="mp-hero-bar">
        <div className="mp-hero-inner">
          <h1>Offer Board</h1>
          <div className="mp-offers-sort">
            {(['price', 'rarity', 'recent'] as SortKey[]).map(s => (
              <button
                key={s}
                className={`mp-filter-btn${sort === s ? ' active' : ''}`}
                onClick={() => { setSort(s); setPage(0); }}
              >
                {s === 'price' ? 'Cheapest' : s === 'rarity' ? 'Rarest' : 'Newest'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {takeMsg && (
        <div className={`mp-offers-toast ${takeMsg.includes('!') ? 'success' : 'error'}`}>
          {takeMsg}
          <button onClick={() => setTakeMsg(null)}>✕</button>
        </div>
      )}

      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 24px' }}>
        {total > 0 && (
          <div style={{ color: '#4b5563', fontSize: 13, marginBottom: 16 }}>
            {total.toLocaleString()} open {total === 1 ? 'ask' : 'asks'}
          </div>
        )}

        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
            <div className="mp-spinner" />
          </div>
        ) : offers.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '80px 24px', color: '#4b5563' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📋</div>
            <div style={{ fontSize: 16, color: '#94a3b8', marginBottom: 8 }}>No open asks yet</div>
            <div style={{ fontSize: 13, marginBottom: 24 }}>
              Browse a collection and list an NFT for sale to see it here.
            </div>
            <button className="mp-btn-primary" onClick={() => navigate('/marketplace')}>
              Browse Collections
            </button>
          </div>
        ) : (
          <>
            <div className="mp-offers-grid">
              {offers.map(o => (
                <div key={o.offer_id} className="mp-offer-card">
                  <div
                    className="mp-offer-card-img"
                    onClick={() => o.collection_id && navigate(`/marketplace/${o.collection_id}`)}
                    style={{ cursor: o.collection_id ? 'pointer' : 'default' }}
                  >
                    {o.image_url ? (
                      <img src={o.image_url} alt={nftLabel(o)}
                        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                    ) : (
                      <div className="mp-offer-card-img-placeholder">?</div>
                    )}
                    {o.rarity_rank && (
                      <div className="mp-offer-rarity-badge">#{o.rarity_rank}</div>
                    )}
                  </div>

                  <div className="mp-offer-card-body">
                    <div className="mp-offer-card-name">{nftLabel(o)}</div>
                    <div className="mp-offer-card-coll">
                      {o.thumbnail_uri && (
                        <img src={o.thumbnail_uri} alt="" className="mp-offer-coll-thumb" />
                      )}
                      <span>{o.collection_name}</span>
                    </div>
                    <div className="mp-offer-card-price">
                      {formatXch(o.price_mojo)} XCH
                      {xchPrice > 0 && (
                        <span className="mp-offer-card-usd">
                          ≈ ${(Number(o.price_mojo) / 1e12 * xchPrice).toFixed(2)}
                        </span>
                      )}
                    </div>
                    <button
                      className="mp-btn-primary"
                      style={{ width: '100%', marginTop: 8 }}
                      disabled={takingId === o.offer_id}
                      onClick={() => takeOffer(o.offer_id)}
                    >
                      {takingId === o.offer_id ? 'Buying…' : 'Buy Now'}
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {totalPages > 1 && (
              <div className="mp-offers-pagination">
                <button
                  className="mp-filter-btn"
                  disabled={page === 0}
                  onClick={() => setPage(p => p - 1)}
                >← Prev</button>
                <span style={{ color: '#94a3b8', fontSize: 13 }}>
                  Page {page + 1} / {totalPages}
                </span>
                <button
                  className="mp-filter-btn"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage(p => p + 1)}
                >Next →</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
