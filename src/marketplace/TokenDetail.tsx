import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { createChart, CandlestickSeries } from 'lightweight-charts';
import TopNav from '../components/TopNav';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:3002';

interface TokenDetail {
  asset_id: string;
  name: string | null;
  short_name: string | null;
  image_url: string | null;
  tibet_pair_id: string | null;
  current_price_xch: number | null;
  xch_reserve: number | null;
  token_reserve: number | null;
  fee_rate: number | null;
  last_trade_at: string | null;
  last_price_xch: number | null;
  high_24h_xch: number | null;
  low_24h_xch: number | null;
  volume_24h_xch: number;
  volume_7d_xch: number;
}

interface OhlcvRow {
  bucket_start: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume_xch: number;
  trade_count: number;
}

interface Trade {
  price_xch: number;
  amount_tokens: number | null;
  volume_xch: number | null;
  block_height: number | null;
  transferred_at: string;
  source: string;
}

const TIMEFRAMES = ['1h', '4h', '1d', '1w', '1m'] as const;
type TF = typeof TIMEFRAMES[number];

function fmtXch(v: number | null | undefined, digits = 8): string {
  if (v == null) return '—';
  if (Math.abs(v) < 1e-8) return '< 0.00000001';
  return v.toFixed(digits).replace(/\.?0+$/, '');
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function TokenDetailScreen() {
  const { assetId } = useParams<{ assetId: string }>();
  const nav = useNavigate();

  const [token, setToken]         = useState<TokenDetail | null>(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [timeframe, setTimeframe] = useState<TF>('1d');
  const [candles, setCandles]     = useState<OhlcvRow[]>([]);
  const [trades, setTrades]       = useState<Trade[]>([]);
  const [xchPrice, setXchPrice]   = useState(0);
  const [tab, setTab]             = useState<'chart' | 'trades'>('chart');

  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef          = useRef<ReturnType<typeof createChart> | null>(null);
  const seriesRef         = useRef<ReturnType<ReturnType<typeof createChart>['addSeries']> | null>(null);
  const roRef             = useRef<ResizeObserver | null>(null);

  // Fetch XCH price
  useEffect(() => {
    const cached = parseFloat(localStorage.getItem('xch_price_usd') || '0');
    if (cached) setXchPrice(cached);
    fetch('/proxy/price/xch', { signal: AbortSignal.timeout(5000) })
      .then(r => r.json()).then(d => { if (d.price) setXchPrice(d.price); })
      .catch(() => {});
  }, []);

  // Fetch token detail
  useEffect(() => {
    if (!assetId) return;
    setLoading(true);
    fetch(`${API_URL}/api/tokens/${assetId}`, { signal: AbortSignal.timeout(10000) })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => { setToken(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [assetId]);

  // Fetch OHLCV candles when timeframe changes
  useEffect(() => {
    if (!assetId) return;
    fetch(`${API_URL}/api/tokens/${assetId}/ohlcv?timeframe=${timeframe}&limit=500`, { signal: AbortSignal.timeout(10000) })
      .then(r => r.json())
      .then(setCandles)
      .catch(() => setCandles([]));
  }, [assetId, timeframe]);

  // Fetch recent trades
  useEffect(() => {
    if (!assetId) return;
    fetch(`${API_URL}/api/tokens/${assetId}/trades?limit=50`, { signal: AbortSignal.timeout(10000) })
      .then(r => r.json())
      .then(setTrades)
      .catch(() => setTrades([]));
  }, [assetId]);

  // Create chart after token load so the container has a real clientWidth
  useEffect(() => {
    if (loading || !chartContainerRef.current || chartRef.current) return;
    const container = chartContainerRef.current;
    const w = container.clientWidth || container.offsetWidth || 900;

    chartRef.current = createChart(container, {
      width: w,
      height: 360,
      layout: {
        background: { color: 'var(--bg-card, #18181b)' } as any,
        textColor: '#a1a1aa',
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.05)' },
        horzLines: { color: 'rgba(255,255,255,0.05)' },
      },
      crosshair: { mode: 1 },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.1)' },
      timeScale: { borderColor: 'rgba(255,255,255,0.1)', timeVisible: true },
    });

    seriesRef.current = chartRef.current.addSeries(CandlestickSeries, {
      upColor:   '#22c55e',
      downColor: '#ef4444',
      borderUpColor:   '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor:   '#22c55e',
      wickDownColor: '#ef4444',
      priceFormat: {
        type: 'custom',
        formatter: (price: number) => {
          if (!price) return '0';
          if (price < 0.000001)  return price.toExponential(2);
          if (price < 0.0001)    return price.toFixed(8);
          if (price < 0.01)      return price.toFixed(6);
          if (price < 1)         return price.toFixed(4);
          return price.toFixed(2);
        },
        minMove: 0.00000001,
      } as any,
    });

    roRef.current = new ResizeObserver(() => {
      if (chartRef.current && chartContainerRef.current) {
        chartRef.current.applyOptions({ width: chartContainerRef.current.clientWidth });
      }
    });
    roRef.current.observe(container);

    return () => {
      roRef.current?.disconnect();
      chartRef.current?.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [loading]);

  // Update candle data whenever it changes
  useEffect(() => {
    if (!seriesRef.current) return;
    if (candles.length) {
      const data = candles.map(c => ({
        time: Math.floor(new Date(c.bucket_start).getTime() / 1000) as any,
        open:  Number(c.open),
        high:  Number(c.high),
        low:   Number(c.low),
        close: Number(c.close),
      }));
      seriesRef.current.setData(data);
      chartRef.current?.timeScale().fitContent();
    } else {
      seriesRef.current.setData([]);
    }
  }, [candles]);

  if (loading) return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
      <TopNav activePath="/tokens" />
      <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-secondary)' }}>Loading…</div>
    </div>
  );

  if (error || !token) return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
      <TopNav activePath="/tokens" />
      <div style={{ textAlign: 'center', padding: 60, color: 'var(--error)' }}>{error || 'Token not found'}</div>
    </div>
  );

  const displayName = token.name || token.short_name || token.asset_id.slice(0, 12);
  const priceUsd    = token.current_price_xch && xchPrice ? token.current_price_xch * xchPrice : null;
  const tvlXch      = token.xch_reserve ? Number(token.xch_reserve) / 1e12 * 2 : null;
  const tvlUsd      = tvlXch && xchPrice ? tvlXch * xchPrice : null;

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
      <TopNav activePath="/tokens" />

      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 16px' }}>

        {/* Back + header */}
        <button onClick={() => nav('/tokens')}
          style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, marginBottom: 16, padding: 0 }}>
          ← All Tokens
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
          {token.image_url
            ? <img src={token.image_url} alt="" style={{ width: 56, height: 56, borderRadius: '50%', objectFit: 'cover' }} onError={e => { e.currentTarget.style.display = 'none'; }} />
            : <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'var(--bg-card)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, fontWeight: 700, color: 'var(--text-secondary)' }}>{displayName[0]}</div>
          }
          <div>
            <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0 }}>{displayName}</h1>
            {token.short_name && <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{token.short_name}</div>}
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <div style={{ fontSize: 28, fontWeight: 700 }}>
              {fmtXch(token.current_price_xch, 8)} XCH
            </div>
            {priceUsd != null && (
              <div style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
                ≈ ${priceUsd.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 6 })}
              </div>
            )}
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>Tibet AMM price</div>
          </div>
        </div>

        {/* Stat chips */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 24 }}>
          {[
            { label: '24h High', value: fmtXch(token.high_24h_xch, 8) + ' XCH' },
            { label: '24h Low',  value: fmtXch(token.low_24h_xch,  8) + ' XCH' },
            { label: '24h Volume', value: token.volume_24h_xch > 0 ? `${fmtXch(token.volume_24h_xch, 2)} XCH` : '—' },
            { label: '7d Volume',  value: token.volume_7d_xch  > 0 ? `${fmtXch(token.volume_7d_xch,  2)} XCH` : '—' },
            { label: 'TVL', value: tvlUsd ? `$${tvlUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : (tvlXch ? `${fmtXch(tvlXch, 2)} XCH` : '—') },
            { label: 'Fee Rate', value: token.fee_rate != null ? `${(Number(token.fee_rate) * 100).toFixed(2)}%` : '—' },
            { label: 'Last Trade', value: token.last_trade_at ? timeAgo(token.last_trade_at) : '—' },
          ].map(s => (
            <div key={s.label} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '10px 16px', minWidth: 120 }}>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>{s.label}</div>
              <div style={{ fontSize: 13, fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{s.value}</div>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)', marginBottom: 0 }}>
          {(['chart', 'trades'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              style={{ padding: '10px 20px', background: 'none', border: 'none', borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
                color: tab === t ? 'var(--text-primary)' : 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontWeight: tab === t ? 600 : 400, textTransform: 'capitalize' }}>
              {t === 'chart' ? 'Price Chart' : 'Trade History'}
            </button>
          ))}
        </div>

        {/* Chart tab — always in DOM so clientWidth is valid on first render */}
        <div style={{ display: tab === 'chart' ? 'block' : 'none', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '0 0 var(--radius) var(--radius)', padding: 16 }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            {TIMEFRAMES.map(tf => (
              <button key={tf} onClick={() => setTimeframe(tf)}
                style={{ padding: '5px 10px', borderRadius: 'var(--radius-sm)', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                  background: timeframe === tf ? 'var(--accent)' : 'var(--bg-input)',
                  color: timeframe === tf ? '#fff' : 'var(--text-secondary)' }}>
                {tf.toUpperCase()}
              </button>
            ))}
          </div>

          <div style={{ position: 'relative' }}>
            <div ref={chartContainerRef} style={{ width: '100%', height: 360 }} />
            {candles.length === 0 && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', fontSize: 13, pointerEvents: 'none' }}>
                No chart data yet
              </div>
            )}
          </div>
        </div>

        {/* Trades tab */}
        {tab === 'trades' && (
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '0 0 var(--radius) var(--radius)', overflowX: 'auto' }}>
            {trades.length === 0
              ? <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>No trades found</div>
              : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                      <th style={{ padding: '10px 14px', textAlign: 'left' }}>Date</th>
                      <th style={{ padding: '10px 14px', textAlign: 'right' }}>Price (XCH)</th>
                      <th style={{ padding: '10px 14px', textAlign: 'right' }}>Amount</th>
                      <th style={{ padding: '10px 14px', textAlign: 'right' }}>Volume (XCH)</th>
                      <th style={{ padding: '10px 14px', textAlign: 'right' }}>Block</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map((t, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '10px 14px', color: 'var(--text-secondary)' }}>{fmtDate(t.transferred_at)}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{fmtXch(t.price_xch, 8)}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                          {t.amount_tokens != null ? t.amount_tokens.toLocaleString(undefined, { maximumFractionDigits: 3 }) : '—'}
                        </td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                          {t.volume_xch != null ? fmtXch(t.volume_xch, 4) : '—'}
                        </td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', color: 'var(--text-secondary)' }}>
                          {t.block_height?.toLocaleString() ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            }
          </div>
        )}

        {/* Asset ID */}
        <div style={{ marginTop: 16, fontSize: 11, color: 'var(--text-secondary)', wordBreak: 'break-all', fontFamily: 'var(--font-mono)' }}>
          Asset ID: {token.asset_id}
          {token.tibet_pair_id && (
            <> · <a href={`https://v2.tibetswap.io/trade/${token.tibet_pair_id}`} target="_blank" rel="noreferrer"
              style={{ color: 'var(--accent)' }}>Trade on Tibet ↗</a></>
          )}
        </div>
      </div>
    </div>
  );
}
