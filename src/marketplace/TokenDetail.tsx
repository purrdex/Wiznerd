import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { createChart, CandlestickSeries, HistogramSeries, LineSeries } from 'lightweight-charts';
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
  transferred_at: string;
  source: string;
  side: 'buy' | 'sell' | null;
}

interface Legend { o: number; h: number; l: number; c: number; v: number }

const TIMEFRAMES = ['1min', '15min', '1h', '4h', '1d', '1w', '1m', '3mo'] as const;
type TF = typeof TIMEFRAMES[number];

const TF_LABEL: Record<TF, string> = {
  '1min': '1m', '15min': '15m', '1h': '1H', '4h': '4H',
  '1d': '1D', '1w': '1W', '1m': '1Mo', '3mo': '3Mo',
};
type SeriesRef = ReturnType<ReturnType<typeof createChart>['addSeries']> | null;
type IndicatorKey = 'macd' | 'rsi' | 'cv';

// ── Indicator math ────────────────────────────────────────────────────────────

function computeSMA(candles: OhlcvRow[], period: number) {
  return candles
    .map((c, i) => {
      if (i < period - 1) return null;
      const slice = candles.slice(i - period + 1, i + 1);
      const avg = slice.reduce((s, x) => s + Number(x.close), 0) / period;
      return { time: Math.floor(new Date(c.bucket_start).getTime() / 1000) as any, value: avg };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

function computeEMA(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { out.push(NaN); continue; }
    if (i === period - 1) {
      out.push(values.slice(0, period).reduce((a, b) => a + b, 0) / period);
      continue;
    }
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function computeMACD(candles: OhlcvRow[]) {
  const closes = candles.map(c => Number(c.close));
  const ema12  = computeEMA(closes, 12);
  const ema26  = computeEMA(closes, 26);
  const tv     = (i: number) => Math.floor(new Date(candles[i].bucket_start).getTime() / 1000) as any;

  const macdRaw: number[] = [];
  const macdIdx: number[] = [];
  for (let i = 25; i < closes.length; i++) {
    macdRaw.push(ema12[i] - ema26[i]);
    macdIdx.push(i);
  }
  if (macdRaw.length < 9) return { histData: [], lineData: [], signalData: [] };

  const sigRaw = computeEMA(macdRaw, 9);
  const histData: any[] = [], lineData: any[] = [], signalData: any[] = [];

  for (let i = 8; i < macdRaw.length; i++) {
    if (isNaN(sigRaw[i])) continue;
    const t = tv(macdIdx[i]);
    const macd = macdRaw[i], sig = sigRaw[i], hist = macd - sig;
    lineData.push({ time: t, value: macd });
    signalData.push({ time: t, value: sig });
    histData.push({ time: t, value: hist, color: hist >= 0 ? 'rgba(34,197,94,0.8)' : 'rgba(239,68,68,0.8)' });
  }
  return { histData, lineData, signalData };
}

function computeRSI(candles: OhlcvRow[], period = 14) {
  const closes = candles.map(c => Number(c.close));
  if (closes.length < period + 1) return [];

  const result: { time: any; value: number }[] = [];
  let avgGain = 0, avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
  }
  avgGain /= period;
  avgLoss /= period;

  const push = (i: number) => {
    const rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
    result.push({ time: Math.floor(new Date(candles[i].bucket_start).getTime() / 1000) as any, value: rsi });
  };
  push(period);

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
    push(i);
  }
  return result;
}

// Chaikin Volatility: rate-of-change of EMA(High-Low, period) over period bars
function computeChaikinVol(candles: OhlcvRow[], period = 10) {
  if (candles.length < period * 2) return [];
  const hl    = candles.map(c => Number(c.high) - Number(c.low));
  const emaHl = computeEMA(hl, period);
  const result: any[] = [];

  for (let i = period; i < candles.length; i++) {
    if (isNaN(emaHl[i]) || isNaN(emaHl[i - period]) || emaHl[i - period] === 0) continue;
    const cv = ((emaHl[i] - emaHl[i - period]) / emaHl[i - period]) * 100;
    result.push({
      time: Math.floor(new Date(candles[i].bucket_start).getTime() / 1000) as any,
      value: cv,
      color: cv >= 0 ? 'rgba(34,197,94,0.8)' : 'rgba(239,68,68,0.8)',
    });
  }
  return result;
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtXch(v: number | null | undefined, digits = 8): string {
  if (v == null) return '—';
  if (Math.abs(v) < 1e-8) return '< 0.00000001';
  return v.toFixed(digits).replace(/\.?0+$/, '');
}

function fmtPrice(v: number): string {
  if (!v) return '0';
  if (Math.abs(v) < 0.000001) return v.toExponential(2);
  if (Math.abs(v) < 0.0001)   return v.toFixed(8);
  if (Math.abs(v) < 0.01)     return v.toFixed(6);
  if (Math.abs(v) < 1)        return v.toFixed(4);
  return v.toFixed(2);
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

// ── Component ─────────────────────────────────────────────────────────────────

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
  const [ma20On, setMa20On]       = useState(true);
  const [ma50On, setMa50On]       = useState(false);
  const [macdOn, setMacdOn]       = useState(false);
  const [rsiOn,  setRsiOn]        = useState(false);
  const [cvOn,   setCvOn]         = useState(false);
  const [legend, setLegend]       = useState<Legend | null>(null);

  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef          = useRef<ReturnType<typeof createChart> | null>(null);
  const seriesRef         = useRef<SeriesRef>(null);
  const volSeriesRef      = useRef<SeriesRef>(null);
  const ma20Ref           = useRef<SeriesRef>(null);
  const ma50Ref           = useRef<SeriesRef>(null);
  const macdHistRef       = useRef<SeriesRef>(null);
  const macdLineRef       = useRef<SeriesRef>(null);
  const macdSignalRef     = useRef<SeriesRef>(null);
  const rsiSeriesRef      = useRef<SeriesRef>(null);
  const cvSeriesRef       = useRef<SeriesRef>(null);
  const roRef             = useRef<ResizeObserver | null>(null);
  // Tracks pane index for each sub-indicator so removePane can shift correctly
  const panesRef          = useRef<Map<IndicatorKey, number>>(new Map());

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
    fetch(`${API_URL}/api/tokens/${assetId}/ohlcv?timeframe=${timeframe}&limit=1000`, { signal: AbortSignal.timeout(10000) })
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

  // Chart creation + all series data (single effect to avoid race conditions)
  useEffect(() => {
    if (loading || !chartContainerRef.current) return;

    if (!chartRef.current) {
      const container = chartContainerRef.current;
      const w = container.clientWidth || container.offsetWidth || 900;

      const chart = createChart(container, {
        width: w, height: 380,
        layout: { background: { color: 'var(--bg-card, #18181b)' } as any, textColor: '#a1a1aa' },
        grid: { vertLines: { color: 'rgba(255,255,255,0.05)' }, horzLines: { color: 'rgba(255,255,255,0.05)' } },
        crosshair: { mode: 1 },
        rightPriceScale: { borderColor: 'rgba(255,255,255,0.1)', scaleMargins: { top: 0.05, bottom: 0.22 } },
        timeScale: { borderColor: 'rgba(255,255,255,0.1)', timeVisible: true },
      });
      chartRef.current = chart;

      seriesRef.current = chart.addSeries(CandlestickSeries, {
        upColor: '#22c55e', downColor: '#ef4444',
        borderUpColor: '#22c55e', borderDownColor: '#ef4444',
        wickUpColor: '#22c55e', wickDownColor: '#ef4444',
        priceFormat: { type: 'custom', formatter: fmtPrice, minMove: 0.00000001 } as any,
      });

      volSeriesRef.current = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' }, priceScaleId: 'vol', color: 'rgba(34,197,94,0.35)',
      } as any);
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

      ma20Ref.current = chart.addSeries(LineSeries, {
        color: '#f59e0b', lineWidth: 1,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      } as any);
      ma50Ref.current = chart.addSeries(LineSeries, {
        color: '#8b5cf6', lineWidth: 1,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      } as any);

      chart.subscribeCrosshairMove(param => {
        if (!param.time || !param.seriesData.size) { setLegend(null); return; }
        const cd = param.seriesData.get(seriesRef.current as any) as any;
        const vd = param.seriesData.get(volSeriesRef.current as any) as any;
        if (cd) setLegend({ o: cd.open, h: cd.high, l: cd.low, c: cd.close, v: vd?.value ?? 0 });
        else setLegend(null);
      });

      roRef.current = new ResizeObserver(() => {
        if (chartRef.current && chartContainerRef.current)
          chartRef.current.applyOptions({ width: chartContainerRef.current.clientWidth });
      });
      roRef.current.observe(container);
    }

    const chart = chartRef.current!;

    // ── Sub-pane lifecycle helper ──────────────────────────────────────────────
    // Adds a new pane and returns its index; updates panesRef.
    const openPane = (key: IndicatorKey): number => {
      chart.addPane();
      const idx = chart.panes().length - 1;
      panesRef.current.set(key, idx);
      return idx;
    };
    // Removes the pane and shifts tracked indices for remaining panes.
    const closePane = (key: IndicatorKey) => {
      const idx = panesRef.current.get(key);
      if (idx == null) return;
      chart.removePane(idx);
      panesRef.current.delete(key);
      for (const [k, v] of panesRef.current.entries()) {
        if (v > idx) panesRef.current.set(k, v - 1);
      }
    };

    // ── MACD ──────────────────────────────────────────────────────────────────
    if (macdOn && !panesRef.current.has('macd')) {
      const pi = openPane('macd');
      macdHistRef.current = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'custom', formatter: fmtPrice, minMove: 0.00000001 } as any,
      }, pi);
      macdLineRef.current = chart.addSeries(LineSeries, {
        color: '#06b6d4', lineWidth: 1,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        priceFormat: { type: 'custom', formatter: fmtPrice, minMove: 0.00000001 } as any,
      } as any, pi);
      macdSignalRef.current = chart.addSeries(LineSeries, {
        color: '#f97316', lineWidth: 1,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        priceFormat: { type: 'custom', formatter: fmtPrice, minMove: 0.00000001 } as any,
      } as any, pi);
    } else if (!macdOn && panesRef.current.has('macd')) {
      closePane('macd');
      macdHistRef.current = macdLineRef.current = macdSignalRef.current = null;
    }

    // ── RSI ───────────────────────────────────────────────────────────────────
    if (rsiOn && !panesRef.current.has('rsi')) {
      const pi = openPane('rsi');
      const rsiSeries = chart.addSeries(LineSeries, {
        color: '#a78bfa', lineWidth: 1,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 } as any,
      } as any, pi);
      // Reference lines at 70 / 50 / 30
      rsiSeries.createPriceLine({ price: 70, color: 'rgba(239,68,68,0.5)',   lineWidth: 1, lineStyle: 2 as any, axisLabelVisible: false });
      rsiSeries.createPriceLine({ price: 50, color: 'rgba(255,255,255,0.15)', lineWidth: 1, lineStyle: 2 as any, axisLabelVisible: false });
      rsiSeries.createPriceLine({ price: 30, color: 'rgba(34,197,94,0.5)',   lineWidth: 1, lineStyle: 2 as any, axisLabelVisible: false });
      rsiSeriesRef.current = rsiSeries;
    } else if (!rsiOn && panesRef.current.has('rsi')) {
      closePane('rsi');
      rsiSeriesRef.current = null;
    }

    // ── Chaikin Volatility ────────────────────────────────────────────────────
    if (cvOn && !panesRef.current.has('cv')) {
      const pi = openPane('cv');
      cvSeriesRef.current = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 } as any,
        color: 'rgba(34,197,94,0.8)',
      } as any, pi);
    } else if (!cvOn && panesRef.current.has('cv')) {
      closePane('cv');
      cvSeriesRef.current = null;
    }

    // ── Update all series data ─────────────────────────────────────────────────
    if (candles.length) {
      const tv = (c: OhlcvRow) => Math.floor(new Date(c.bucket_start).getTime() / 1000) as any;

      seriesRef.current?.setData(candles.map(c => ({
        time: tv(c), open: Number(c.open), high: Number(c.high),
        low: Number(c.low), close: Number(c.close),
      })));
      volSeriesRef.current?.setData(candles.map(c => ({
        time: tv(c), value: Number(c.volume_xch),
        color: Number(c.close) >= Number(c.open) ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)',
      })));
      ma20Ref.current?.setData(ma20On ? computeSMA(candles, 20) : []);
      ma50Ref.current?.setData(ma50On ? computeSMA(candles, 50) : []);

      if (macdOn) {
        const { histData, lineData, signalData } = computeMACD(candles);
        macdHistRef.current?.setData(histData);
        macdLineRef.current?.setData(lineData);
        macdSignalRef.current?.setData(signalData);
      }
      if (rsiOn)  rsiSeriesRef.current?.setData(computeRSI(candles));
      if (cvOn)   cvSeriesRef.current?.setData(computeChaikinVol(candles));

      chart.timeScale().fitContent();
    } else {
      seriesRef.current?.setData([]);
      volSeriesRef.current?.setData([]);
      ma20Ref.current?.setData([]);
      ma50Ref.current?.setData([]);
      macdHistRef.current?.setData([]);
      macdLineRef.current?.setData([]);
      macdSignalRef.current?.setData([]);
      rsiSeriesRef.current?.setData([]);
      cvSeriesRef.current?.setData([]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, candles, ma20On, ma50On, macdOn, rsiOn, cvOn]);

  // Destroy chart only on unmount
  useEffect(() => {
    return () => {
      roRef.current?.disconnect();
      chartRef.current?.remove();
      chartRef.current = null;
      seriesRef.current = volSeriesRef.current = null;
      ma20Ref.current = ma50Ref.current = null;
      macdHistRef.current = macdLineRef.current = macdSignalRef.current = null;
      rsiSeriesRef.current = cvSeriesRef.current = null;
      panesRef.current.clear();
    };
  }, []);

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
  const headerPrice = token.last_price_xch ?? token.current_price_xch;
  const priceUsd    = headerPrice && xchPrice ? headerPrice * xchPrice : null;
  const tvlXch      = token.xch_reserve ? Number(token.xch_reserve) / 1e12 * 2 : null;
  const tvlUsd      = tvlXch && xchPrice ? tvlXch * xchPrice : null;

  const indicatorBtn = (label: string, on: boolean, toggle: () => void, color: string, bg: string) => (
    <button onClick={toggle}
      style={{ padding: '5px 10px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 12, fontWeight: 600,
        border: `1px solid ${on ? color : 'transparent'}`,
        background: on ? bg : 'var(--bg-input)',
        color: on ? color : 'var(--text-secondary)' }}>
      {label}
    </button>
  );

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
      <TopNav activePath="/tokens" />

      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 16px' }}>

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
            <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, color: 'var(--accent)' }}>{displayName}</h1>
            {token.short_name && <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{token.short_name}</div>}
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{fmtXch(headerPrice, 8)} XCH</div>
            {priceUsd != null && (
              <div style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
                ≈ ${priceUsd.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 6 })}
              </div>
            )}
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>Last trade price</div>
          </div>
        </div>

        {/* Stat chips */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 24 }}>
          {[
            { label: 'AMM Price',  value: fmtXch(token.current_price_xch, 8) + ' XCH' },
            { label: '24h High',   value: fmtXch(token.high_24h_xch, 8)      + ' XCH' },
            { label: '24h Low',    value: fmtXch(token.low_24h_xch,  8)      + ' XCH' },
            { label: '24h Volume', value: token.volume_24h_xch > 0 ? `${fmtXch(token.volume_24h_xch, 2)} XCH` : '—' },
            { label: '7d Volume',  value: token.volume_7d_xch  > 0 ? `${fmtXch(token.volume_7d_xch,  2)} XCH` : '—' },
            { label: 'TVL',        value: tvlUsd ? `$${tvlUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : (tvlXch ? `${fmtXch(tvlXch, 2)} XCH` : '—') },
            { label: 'Fee Rate',   value: token.fee_rate != null ? `${(Number(token.fee_rate) * 100).toFixed(2)}%` : '—' },
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

          {/* Toolbar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
            {TIMEFRAMES.map(tf => (
              <button key={tf} onClick={() => setTimeframe(tf)}
                style={{ padding: '5px 10px', borderRadius: 'var(--radius-sm)', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                  background: timeframe === tf ? 'var(--accent)' : 'var(--bg-input)',
                  color: timeframe === tf ? '#fff' : 'var(--text-secondary)' }}>
                {TF_LABEL[tf]}
              </button>
            ))}
            <div style={{ width: 1, height: 18, background: 'var(--border)', margin: '0 2px' }} />
            {indicatorBtn('MA 20', ma20On, () => setMa20On(v => !v), '#f59e0b', 'rgba(245,158,11,0.15)')}
            {indicatorBtn('MA 50', ma50On, () => setMa50On(v => !v), '#8b5cf6', 'rgba(139,92,246,0.15)')}
            {indicatorBtn('MACD',  macdOn, () => setMacdOn(v => !v), '#06b6d4', 'rgba(6,182,212,0.15)')}
            {indicatorBtn('RSI',   rsiOn,  () => setRsiOn(v => !v),  '#a78bfa', 'rgba(167,139,250,0.15)')}
            {indicatorBtn('CV',    cvOn,   () => setCvOn(v => !v),   '#2dd4bf', 'rgba(45,212,191,0.15)')}
          </div>

          <div style={{ position: 'relative' }}>
            {/* OHLCV crosshair legend */}
            {legend && (
              <div style={{ position: 'absolute', top: 8, left: 8, zIndex: 10, display: 'flex', gap: 10, fontSize: 11,
                fontFamily: 'var(--font-mono)', pointerEvents: 'none',
                background: 'rgba(24,24,27,0.85)', padding: '4px 8px', borderRadius: 4, backdropFilter: 'blur(4px)' }}>
                <span><span style={{ color: '#71717a' }}>O </span><span>{fmtPrice(legend.o)}</span></span>
                <span><span style={{ color: '#71717a' }}>H </span><span style={{ color: '#22c55e' }}>{fmtPrice(legend.h)}</span></span>
                <span><span style={{ color: '#71717a' }}>L </span><span style={{ color: '#ef4444' }}>{fmtPrice(legend.l)}</span></span>
                <span><span style={{ color: '#71717a' }}>C </span><span>{fmtPrice(legend.c)}</span></span>
                <span><span style={{ color: '#71717a' }}>V </span><span style={{ color: '#a1a1aa' }}>{legend.v.toFixed(2)}</span></span>
              </div>
            )}
            <div ref={chartContainerRef} style={{ width: '100%', height: 380 }} />
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
                      <th style={{ padding: '10px 14px', textAlign: 'right' }}>Type</th>
                      <th style={{ padding: '10px 14px', textAlign: 'right' }}>Price (XCH)</th>
                      <th style={{ padding: '10px 14px', textAlign: 'right' }}>Amount</th>
                      <th style={{ padding: '10px 14px', textAlign: 'right' }}>Volume (XCH)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map((t, i) => {
                      const color = t.side === 'buy' ? '#22c55e' : t.side === 'sell' ? '#ef4444' : 'var(--text-primary)';
                      return (
                      <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '10px 14px', color: 'var(--text-secondary)', fontSize: 12 }}>{fmtDate(t.transferred_at)}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 600, color }}>
                          {t.side ? t.side.toUpperCase() : '—'}
                        </td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontFamily: 'var(--font-mono)', color }}>{fmtXch(t.price_xch, 8)}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontFamily: 'var(--font-mono)', color }}>
                          {t.amount_tokens != null ? t.amount_tokens.toLocaleString(undefined, { maximumFractionDigits: 3 }) : '—'}
                        </td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontFamily: 'var(--font-mono)', color }}>
                          {t.volume_xch != null ? fmtXch(t.volume_xch, 4) : '—'}
                        </td>
                      </tr>
                      );
                    })}
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
