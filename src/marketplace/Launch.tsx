import { useState, useEffect, useRef } from 'react';
import TopNav from '../components/TopNav';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:3002';
const WIZNERD_FEE_XCH = 0.537;
const TIBET_FEE_XCH   = 0.463;
const DEFAULT_SUPPLY   = 1_000_000_000; // 1 billion CATs

type Step = 'form' | 'review' | 'payment' | 'processing' | 'done' | 'error';

interface LaunchStatus {
  id: string;
  status: string;
  asset_id?: string;
  pair_coin_id?: string;
  error_message?: string;
  payment_address: string;
  payment_mojo: number;
}

function fmtXch(mojo: number) {
  return (mojo / 1e12).toFixed(4).replace(/\.?0+$/, '');
}

export default function LaunchPage() {
  const [step, setStep]               = useState<Step>('form');
  const [name, setName]               = useState('');
  const [symbol, setSymbol]           = useState('');
  const [description, setDescription] = useState('');
  const [imageFile, setImageFile]     = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState('');
  const [imageUrl, setImageUrl]       = useState('');
  const [xchLiquidity, setXchLiquidity] = useState('1');
  const [recipientAddr, setRecipientAddr] = useState(() => {
    try { return localStorage.getItem('chia_primary_address') || ''; } catch { return ''; }
  });
  const [launch, setLaunch]           = useState<LaunchStatus | null>(null);
  const [error, setError]             = useState('');
  const [submitting, setSubmitting]   = useState(false);
  const [copied, setCopied]           = useState(false);
  const pollRef                       = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileRef                       = useRef<HTMLInputElement>(null);

  const totalFeeXch = WIZNERD_FEE_XCH + TIBET_FEE_XCH;
  const xchLiqNum   = parseFloat(xchLiquidity) || 0;
  const totalXch    = totalFeeXch + xchLiqNum;

  function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setImageFile(f);
    const reader = new FileReader();
    reader.onload = ev => setImagePreview(ev.target?.result as string);
    reader.readAsDataURL(f);
  }

  function validate() {
    if (!name.trim())       return 'Token name required';
    if (!symbol.trim())     return 'Symbol required';
    if (symbol.length > 12) return 'Symbol max 12 characters';
    if (xchLiqNum <= 0)     return 'XCH liquidity must be > 0';
    if (!recipientAddr.startsWith('xch1')) return 'Valid XCH recipient address required';
    return '';
  }

  async function uploadImage(): Promise<string> {
    if (!imageFile) return imageUrl;
    // Convert to base64 for SpaceScan; store URL in our DB via data URL
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = ev => resolve(ev.target?.result as string);
      reader.readAsDataURL(imageFile);
    });
  }

  async function handleSubmit() {
    const err = validate();
    if (err) { setError(err); return; }
    setError('');
    setSubmitting(true);
    try {
      const imgData = await uploadImage();

      const supplyMojos = DEFAULT_SUPPLY * 1000; // all 1B CATs in mojos
      const r = await fetch(`${API_URL}/api/launch/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:             name.trim(),
          symbol:           symbol.trim().toUpperCase(),
          description:      description.trim(),
          image_url:        imgData || imageUrl,
          total_supply:     supplyMojos,
          xch_liquidity:    Math.floor(xchLiqNum * 1e12),
          cat_liquidity:    supplyMojos, // all tokens go into the pool
          creator_address:  recipientAddr.trim(),
        }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Server error');
      setLaunch(data);
      setStep('payment');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to initialize launch');
    } finally {
      setSubmitting(false);
    }
  }

  // Poll launch status once payment step is active
  useEffect(() => {
    if (step !== 'payment' && step !== 'processing') return;
    if (!launch?.id) return;

    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`${API_URL}/api/launch/${launch.id}`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return;
        const d: LaunchStatus = await r.json();
        setLaunch(prev => ({ ...prev!, ...d }));
        if (d.status === 'paid' || d.status === 'minting' || d.status === 'minted' || d.status === 'deploying') {
          setStep('processing');
        } else if (d.status === 'live') {
          setStep('done');
          clearInterval(pollRef.current!);
        } else if (d.status === 'failed' || d.status === 'expired') {
          setError(d.error_message || 'Launch failed');
          setStep('error');
          clearInterval(pollRef.current!);
        }
      } catch { /* retry */ }
    }, 5000);

    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [step, launch?.id]);

  function copyAddress() {
    if (!launch?.payment_address) return;
    navigator.clipboard.writeText(launch.payment_address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const statusLabel: Record<string, string> = {
    paid:      'Payment confirmed — minting token…',
    minting:   'Minting CAT token…',
    minted:    'Token minted — registering with SpaceScan…',
    deploying: 'Creating TibetSwap pair…',
    live:      'Pair deployed!',
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
      <TopNav activePath="/launch" />
      <div style={{ maxWidth: 520, margin: '0 auto', padding: '32px 16px' }}>

        {/* Header */}
        <div style={{ marginBottom: 28 }}>
          <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, color: 'var(--accent)' }}>Launch a Token</h1>
          <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--text-secondary)' }}>
            Mint a CAT token and deploy a TibetSwap pair in one flow.
          </p>
        </div>

        {/* ── FORM ── */}
        {step === 'form' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

            {/* Image */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 4 }}>
              <div
                onClick={() => fileRef.current?.click()}
                style={{ width: 72, height: 72, borderRadius: '50%', background: 'var(--bg-card)',
                  border: '2px dashed var(--border)', cursor: 'pointer', overflow: 'hidden',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                {imagePreview
                  ? <img src={imagePreview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : <span style={{ fontSize: 24, color: 'var(--text-secondary)' }}>+</span>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>Token Logo</div>
                <div>PNG or JPG, square recommended</div>
                <div style={{ marginTop: 4 }}>
                  Or paste URL:
                  <input value={imageUrl} onChange={e => setImageUrl(e.target.value)}
                    placeholder="https://..."
                    style={{ marginLeft: 6, padding: '2px 6px', background: 'var(--bg-input)',
                      border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-primary)', fontSize: 11, width: 160 }} />
                </div>
              </div>
              <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleImageChange} />
            </div>

            <Field label="Token Name" value={name} onChange={setName} placeholder="e.g. WizCoin" />
            <Field label="Symbol / Ticker" value={symbol} onChange={v => setSymbol(v.toUpperCase())} placeholder="e.g. WIZ" maxLength={12} />
            <Field label="Description" value={description} onChange={setDescription} placeholder="What is this token?" multiline />
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginTop: 4 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Initial Liquidity
              </div>
              <Field label="XCH to Pool" value={xchLiquidity} onChange={setXchLiquidity} placeholder="1" type="number" />
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>
                1,000,000,000 CATs will be minted and seeded into the pool.
              </div>
            </div>

            <Field label="LP Token Recipient Address" value={recipientAddr} onChange={setRecipientAddr} placeholder="xch1..." />

            {/* Fee summary */}
            <div style={{ background: 'var(--bg-card)', borderRadius: 10, padding: '12px 16px', fontSize: 13 }}>
              <Row label="Wiznerd launch fee"  value="0.537 XCH" />
              <Row label="TibetSwap fees"      value="0.463 XCH" />
              <Row label={`Initial XCH liquidity`} value={`${xchLiqNum || '?'} XCH`} />
              <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8 }}>
                <Row label="Total XCH to send" value={`${xchLiqNum > 0 ? totalXch.toFixed(4) : '?'} XCH`} bold />
              </div>
            </div>

            {error && <div style={{ color: 'var(--error)', fontSize: 13 }}>{error}</div>}

            <button
              onClick={handleSubmit}
              disabled={submitting}
              style={{ padding: '14px 0', background: 'var(--accent)', color: '#fff',
                border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 15,
                cursor: submitting ? 'wait' : 'pointer', opacity: submitting ? 0.7 : 1 }}>
              {submitting ? 'Preparing…' : 'Continue →'}
            </button>
          </div>
        )}

        {/* ── PAYMENT ── */}
        {(step === 'payment' || step === 'processing') && launch && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {step === 'payment' && (
              <>
                <div style={{ background: 'var(--bg-card)', borderRadius: 12, padding: 20 }}>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>Send exactly</div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--accent)', marginBottom: 4 }}>
                    {fmtXch(launch.payment_mojo)} XCH
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 16 }}>to this address:</div>
                  <div style={{ background: 'var(--bg-base)', borderRadius: 8, padding: '10px 14px',
                    fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all', marginBottom: 10 }}>
                    {launch.payment_address}
                  </div>
                  <button onClick={copyAddress}
                    style={{ width: '100%', padding: '10px 0', background: copied ? 'var(--success)' : 'var(--bg-input)',
                      border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)',
                      cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                    {copied ? 'Copied!' : 'Copy Address'}
                  </button>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', textAlign: 'center' }}>
                  Waiting for payment · checking every 15 seconds · expires in 30 minutes
                </div>
              </>
            )}

            {step === 'processing' && (
              <div style={{ background: 'var(--bg-card)', borderRadius: 12, padding: 24, textAlign: 'center' }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>⚙️</div>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>
                  {statusLabel[launch.status] || 'Processing…'}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  This takes 1–3 minutes. Don't close this tab.
                </div>
                <div style={{ marginTop: 16, display: 'flex', justifyContent: 'center', gap: 6 }}>
                  {['paid','minting','minted','deploying'].map(s => (
                    <div key={s} style={{ width: 8, height: 8, borderRadius: '50%',
                      background: launch.status === s ? 'var(--accent)' :
                        ['paid','minting','minted','deploying'].indexOf(s) <
                        ['paid','minting','minted','deploying'].indexOf(launch.status) ? 'var(--success)' : 'var(--border)' }} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── DONE ── */}
        {step === 'done' && launch && (
          <div style={{ background: 'var(--bg-card)', borderRadius: 12, padding: 24, textAlign: 'center' }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>🚀</div>
            <div style={{ fontWeight: 700, fontSize: 20, marginBottom: 8 }}>Token Launched!</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20 }}>
              {name} ({symbol}) is now live on TibetSwap.
            </div>
            {launch.asset_id && (
              <div style={{ background: 'var(--bg-base)', borderRadius: 8, padding: '10px 14px',
                fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all', marginBottom: 16 }}>
                {launch.asset_id}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, flexDirection: 'column' }}>
              <a href={`/tokens/${launch.asset_id}`}
                style={{ padding: '12px 0', background: 'var(--accent)', color: '#fff',
                  borderRadius: 10, fontWeight: 700, textDecoration: 'none', display: 'block' }}>
                View on Wiznerd →
              </a>
              {launch.asset_id && (
                <a href={`https://spacescan.io/cat/${launch.asset_id}`} target="_blank" rel="noreferrer"
                  style={{ padding: '12px 0', background: 'var(--bg-input)', color: 'var(--text-primary)',
                    border: '1px solid var(--border)', borderRadius: 10, fontWeight: 600,
                    textDecoration: 'none', display: 'block', fontSize: 13 }}>
                  View on SpaceScan ↗
                </a>
              )}
            </div>
          </div>
        )}

        {/* ── ERROR ── */}
        {step === 'error' && (
          <div style={{ background: 'var(--bg-card)', borderRadius: 12, padding: 24, textAlign: 'center' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>⚠️</div>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>Launch Failed</div>
            <div style={{ fontSize: 13, color: 'var(--error)', marginBottom: 20 }}>{error}</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 20 }}>
              If XCH was already sent, contact support with your launch ID:<br />
              <span style={{ fontFamily: 'monospace' }}>{launch?.id}</span>
            </div>
            <button onClick={() => { setStep('form'); setError(''); }}
              style={{ padding: '12px 24px', background: 'var(--accent)', color: '#fff',
                border: 'none', borderRadius: 10, fontWeight: 700, cursor: 'pointer' }}>
              Try Again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Small helpers ──────────────────────────────────────────────────────────────

function Field({ label, value, onChange, placeholder, type = 'text', maxLength, multiline }: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; type?: string; maxLength?: number; multiline?: boolean;
}) {
  const style: React.CSSProperties = {
    width: '100%', padding: '8px 12px', background: 'var(--bg-input)',
    border: '1px solid var(--border)', borderRadius: 8,
    color: 'var(--text-primary)', fontSize: 14, boxSizing: 'border-box',
    resize: multiline ? 'vertical' : undefined,
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>{label}</label>
      {multiline
        ? <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
            rows={3} style={style} />
        : <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
            type={type} maxLength={maxLength} style={style} />}
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0',
      fontWeight: bold ? 700 : 400, color: bold ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
      <span>{label}</span><span>{value}</span>
    </div>
  );
}
