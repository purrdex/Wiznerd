import { useState } from 'react';
import { useCart } from './CartContext';
import './marketplace.css';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:3002';

function fmtXch(mojo: number): string {
  const v = mojo / 1e12;
  if (v >= 1) return v.toFixed(4).replace(/\.?0+$/, '');
  return v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

export default function CartDrawer({ onClose }: { onClose: () => void }) {
  const { items, removeItem, clearCart } = useCart();
  const [status, setStatus] = useState<'idle' | 'running' | 'done'>('idle');
  const [log, setLog] = useState<{ text: string; ok?: boolean }[]>([]);

  const xchTotal = items.reduce((s, i) => i.price_token === 'xch' ? s + i.price_mojo : s, 0);

  async function checkout() {
    setStatus('running');
    const lines: { text: string; ok?: boolean }[] = [];

    for (const item of items) {
      lines.push({ text: `Buying ${item.nft_name || item.nft_id.slice(0, 14) + '…'}…` });
      setLog([...lines]);
      try {
        const r = await fetch(`${API_URL}/api/nft/offers/${item.offer_id}/take`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(35000),
        });
        const d = await r.json();
        lines[lines.length - 1] = r.ok
          ? { text: `✓ ${item.nft_name || item.nft_id.slice(0, 14)}`, ok: true }
          : { text: `✗ ${item.nft_name || item.nft_id.slice(0, 14)}: ${d.error || 'failed'}`, ok: false };
      } catch (e: unknown) {
        lines[lines.length - 1] = { text: `✗ ${item.nft_name || item.nft_id.slice(0, 14)}: ${e instanceof Error ? e.message : 'network error'}`, ok: false };
      }
      setLog([...lines]);
    }

    const failed = lines.filter(l => l.ok === false).length;
    if (failed === 0) {
      lines.push({ text: 'All done! Cart cleared.', ok: true });
      clearCart();
    } else {
      lines.push({ text: `${items.length - failed} succeeded, ${failed} failed`, ok: false });
    }
    setLog([...lines]);
    setStatus('done');
  }

  return (
    <div className="mp-cart-overlay" onClick={onClose}>
      <div className="mp-cart-drawer" onClick={e => e.stopPropagation()}>
        <div className="mp-cart-header">
          <span className="mp-cart-title">Cart {items.length > 0 && <span className="mp-cart-count-badge">{items.length}</span>}</span>
          <button className="mp-cart-close" onClick={onClose}>✕</button>
        </div>

        {items.length === 0 ? (
          <div className="mp-cart-empty">
            <div style={{ fontSize: 36, marginBottom: 8 }}>🛒</div>
            <div>Your cart is empty.</div>
            <div style={{ fontSize: 12, color: '#4b5563', marginTop: 4 }}>
              Click the cart icon on any listed NFT to add it.
            </div>
          </div>
        ) : status !== 'idle' ? (
          <div className="mp-cart-log">
            {log.map((line, i) => (
              <div key={i} className={`mp-cart-log-line${line.ok === true ? ' ok' : line.ok === false ? ' err' : ''}`}>
                {line.text}
              </div>
            ))}
            {status === 'done' && (
              <button className="mp-cart-btn" style={{ marginTop: 16 }} onClick={onClose}>
                Close
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="mp-cart-items">
              {items.map(item => (
                <div key={item.offer_id} className="mp-cart-item">
                  <div className="mp-cart-item-img">
                    {item.image_url
                      ? <img src={item.image_url} alt="" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                      : <div className="mp-cart-item-ph" />}
                  </div>
                  <div className="mp-cart-item-info">
                    <div className="mp-cart-item-name">{item.nft_name || item.nft_id.slice(0, 14) + '…'}</div>
                    {item.collection_name && <div className="mp-cart-item-col">{item.collection_name}</div>}
                    <div className="mp-cart-item-price">
                      {item.price_token === 'xch'
                        ? `${fmtXch(item.price_mojo)} XCH`
                        : `${(item.price_mojo / 1000).toFixed(3).replace(/0+$/, '')} (${item.price_token.slice(0, 8)})`}
                    </div>
                  </div>
                  <button className="mp-cart-item-remove" onClick={() => removeItem(item.offer_id)}>✕</button>
                </div>
              ))}
            </div>
            <div className="mp-cart-footer">
              {xchTotal > 0 && (
                <div className="mp-cart-total">Total: {fmtXch(xchTotal)} XCH</div>
              )}
              <button className="mp-cart-btn" onClick={checkout}>
                Buy All ({items.length})
              </button>
              <button className="mp-cart-btn-outline" onClick={clearCart}>
                Clear Cart
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
