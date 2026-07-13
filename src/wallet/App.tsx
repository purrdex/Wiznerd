import React, { useState, useEffect, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import './App.css';
import TopNav from '../components/TopNav';
import type { DerivedAddress } from './lib/keys';
import { formatMojoToXch, isValidXchAddress } from './lib/utils';
import {
  checkNodeSync,
  getBalance,
  getCoinRecords,
  type NodeStatus,
  type CoinRecord,
} from './lib/node';
import {
  getCatBalances,
  getCatCoinsByHint,
  calculateCoinId,
  formatCatAmount,
  fetchXchPrice,
  formatCatUsdValue,
  loadCustomAssetIds,
  saveCustomAssetIds,
  getTokenMetadata,
  resolveOuterPuzzleHash,
  type CatBalance,
} from './lib/cats';
import {
  VAULT_SALT_KEY,
  getOrCreateSalt,
  generateAndStoreSalt,
  generateSalt,
  storeSalt,
  deriveKey,
  encryptMnemonic,
  decryptMnemonic,
} from './lib/crypto';

type Screen = 'setup' | 'wallet' | 'send' | 'receive' | 'history' | 'settings' | 'offers' | 'nfts';

interface WalletState {
  mnemonic: string;
  addresses: DerivedAddress[];
}

interface WalletEntry {
  id: string;
  name: string;
  mnemonic?: string;          // legacy plaintext (migration only)
  encryptedMnemonic?: string; // v1: AES-256-GCM JSON blob
  primaryAddress?: string;    // cached xch1... for cross-page switching
}

interface AddressEntry {
  id: string;
  label: string;
  address: string;
}

interface HistoryEvent {
  type: 'received' | 'sent';
  amount: bigint;
  ticker: string;
  label: string;
  assetId: string | null;
  isCat: boolean;
  timestamp: number;
  blockIndex: number;
  txId: string;
}

const IconHome = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
    <path d="M3 12L12 3l9 9M5 10v9a1 1 0 001 1h4v-4h4v4h4a1 1 0 001-1v-9" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);
const IconReceive = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
    <path d="M12 3v12m0 0l-4-4m4 4l4-4M3 17v2a2 2 0 002 2h14a2 2 0 002-2v-2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);
const IconSettings = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
    <circle cx="12" cy="12" r="3"/>
    <path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72l1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" strokeLinecap="round"/>
  </svg>
);
const IconSend = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
    <path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);
const IconHistory = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
    <circle cx="12" cy="12" r="9"/>
    <path d="M12 7v5l3 3" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);
const IconTrade = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
    <path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);
const IconNft = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
    <rect x="3" y="3" width="18" height="18" rx="2"/>
    <circle cx="8.5" cy="8.5" r="1.5"/>
    <path d="M21 15l-5-5L5 21" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const FAILED_STATUS = (url: string): NodeStatus => ({
  url, label: 'Node', peakHeight: 0, synced: false,
  latencyMs: 0, trusted: false, error: 'Connection failed'
});

function NodeBadge({ status }: { status: NodeStatus | null }) {
  if (!status) return <div className="node-badge checking"><div className="node-dot"/>Checking…</div>;
  if (status.trusted) {
    const qualifier = status.latencyMs > 800 ? ' slow' : '';
    return (
      <div className={`node-badge synced${qualifier}`}>
        <div className="node-dot"/>#{status.peakHeight.toLocaleString()} · {status.latencyMs}ms
      </div>
    );
  }
  return <div className="node-badge error"><div className="node-dot"/>Offline</div>;
}

function SetupScreen({ onWalletReady, onCancel, existingKey }: {
  onWalletReady: (mnemonic: string, key: CryptoKey) => Promise<void>;
  onCancel?: () => void;
  existingKey?: CryptoKey | null;
}) {
  const [mode, setMode] = useState<'choose'|'new'|'verify'|'import'|'password'>('choose');
  const [mnemonic, setMnemonic] = useState('');
  const [importInput, setImportInput] = useState('');
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [quizIndices, setQuizIndices] = useState<number[]>([]);
  const [quizAnswers, setQuizAnswers] = useState(['', '', '']);
  const [quizError, setQuizError] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);

  const handleGenerate = async () => {
    const { generateNewMnemonic } = await import('./lib/keys');
    setMnemonic(generateNewMnemonic()); setMode('new');
  };

  const startVerify = () => {
    // Pick 3 distinct random word positions
    const positions: number[] = [];
    while (positions.length < 3) {
      const idx = Math.floor(Math.random() * 24);
      if (!positions.includes(idx)) positions.push(idx);
    }
    positions.sort((a, b) => a - b);
    setQuizIndices(positions);
    setQuizAnswers(['', '', '']);
    setQuizError('');
    setMode('verify');
  };

  const handleConfirmNew = async () => {
    const words = mnemonic.split(' ');
    const wrong = quizIndices.findIndex((idx, i) =>
      quizAnswers[i].trim().toLowerCase() !== words[idx]
    );
    if (wrong !== -1) {
      setQuizError(`Word #${quizIndices[wrong] + 1} is incorrect. Check your backup.`);
      return;
    }
    if (existingKey) {
      try { await onWalletReady(mnemonic, existingKey); }
      catch (e: any) { setQuizError(`Failed: ${e.message}`); }
    } else {
      setMode('password');
    }
  };

  const handleImport = async () => {
    setError('');
    const cleaned = importInput.trim().toLowerCase().replace(/\s+/g, ' ');
    const words = cleaned.split(' ').filter(Boolean);
    if (words.length !== 24) { setError('Invalid mnemonic. Check for typos — must be 24 valid BIP39 words.'); return; }
    const { validateMnemonicWords } = await import('./lib/keys');
    if (!validateMnemonicWords(cleaned)) { setError('Invalid mnemonic. Check for typos — must be 24 valid BIP39 words.'); return; }
    setMnemonic(cleaned);
    if (existingKey) {
      try { await onWalletReady(cleaned, existingKey); }
      catch (e: any) { setError(`Key derivation failed: ${e.message}`); }
    } else {
      setMode('password');
    }
  };

  const handleCreatePassword = async () => {
    if (newPassword.length < 8) { setPasswordError('Password must be at least 8 characters'); return; }
    if (newPassword !== confirmPassword) { setPasswordError('Passwords do not match'); return; }
    setPasswordBusy(true);
    try {
      const saltB64 = getOrCreateSalt();
      const key = await deriveKey(newPassword, saltB64);
      await onWalletReady(mnemonic, key);
    } catch (e: any) {
      setPasswordError(`Failed: ${e.message}`);
    } finally { setPasswordBusy(false); }
  };

  if (mode === 'new') {
    const words = mnemonic.split(' ');
    return (
      <div className="setup-screen">
        <div className="setup-hero">
          <h1>Save your <span className="accent">seed phrase</span></h1>
          <p>Write these 24 words down. Anyone with these words controls your wallet.</p>
        </div>
        <div className="warning-box">⚠️ Never share your seed phrase. There is no recovery without it.</div>
        <div className="mnemonic-grid">
          {words.map((word, i) => (
            <div className="mnemonic-word" key={i}>
              <span className="word-index">{i+1}.</span>
              <span className="word-value">{word}</span>
            </div>
          ))}
        </div>
        <button
          onClick={() => navigator.clipboard.writeText(mnemonic)}
          style={{background:'var(--bg-card)',border:'1px solid var(--border)',color:'var(--text-secondary)',
            borderRadius:8,padding:'8px 16px',fontSize:12,cursor:'pointer',marginBottom:8,width:'100%'}}
        >
          Copy seed phrase (store in password manager, never share)
        </button>
        {error && <div className="error-msg">{error}</div>}
        <label style={{display:'flex',alignItems:'center',gap:10,fontSize:13,color:'var(--text-secondary)',marginBottom:16,cursor:'pointer'}}>
          <input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} style={{width:16,height:16,accentColor:'var(--accent)'}}/>
          I've written down my seed phrase
        </label>
        <button className="btn btn-primary" disabled={!confirmed} onClick={startVerify}>Continue →</button>
        <button className="btn btn-secondary mt-8" onClick={()=>setMode('choose')}>Back</button>
      </div>
    );
  }

  if (mode === 'verify') {
    const words = mnemonic.split(' ');
    return (
      <div className="setup-screen">
        <div className="setup-hero">
          <h1>Verify your <span className="accent">backup</span></h1>
          <p>Enter the words at these positions to confirm you saved your seed phrase.</p>
        </div>
        <div style={{display:'flex',flexDirection:'column',gap:12}}>
          {quizIndices.map((wordIdx, qi) => (
            <div key={qi} style={{background:'var(--bg-card)',border:`1px solid ${quizAnswers[qi].trim().toLowerCase() === words[wordIdx] && quizAnswers[qi] ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius:'var(--radius)',padding:'12px 14px'}}>
              <div style={{fontSize:11,color:'var(--text-secondary)',marginBottom:6,fontWeight:600}}>
                Word #{wordIdx + 1}
              </div>
              <input
                type="text"
                autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                placeholder={`Enter word #${wordIdx + 1}`}
                value={quizAnswers[qi]}
                onChange={e => {
                  const next = [...quizAnswers];
                  next[qi] = e.target.value;
                  setQuizAnswers(next);
                  setQuizError('');
                }}
                style={{width:'100%',boxSizing:'border-box',padding:'9px 12px',
                  background:'var(--bg-input)',border:'1px solid var(--border)',
                  borderRadius:'var(--radius-sm)',color:'var(--text-primary)',fontSize:14,
                  fontFamily:'var(--font-mono)'}}
              />
            </div>
          ))}
        </div>
        {quizError && <div className="error-msg" style={{marginTop:8}}>{quizError}</div>}
        <button
          className="btn btn-primary"
          style={{marginTop:16}}
          disabled={quizAnswers.some(a => !a.trim())}
          onClick={handleConfirmNew}>
          Open Wallet
        </button>
        <button className="btn btn-secondary mt-8" onClick={() => setMode('new')}>Back</button>
      </div>
    );
  }

  if (mode === 'import') {
    return (
      <div className="setup-screen">
        <div className="setup-hero">
          <h1>Import <span className="accent">wallet</span></h1>
          <p>Enter your 24-word seed phrase to restore your wallet.</p>
        </div>
        <div className="import-area">
          <label>Seed phrase (24 words)</label>
          <textarea rows={5} placeholder="word1 word2 word3 ... word24" value={importInput}
            onChange={e=>{setImportInput(e.target.value);setError('');}}
            autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}/>
          {error && <div className="error-msg">{error}</div>}
          <button className="btn btn-primary" onClick={handleImport}>Import Wallet</button>
          <button className="btn btn-secondary" onClick={()=>setMode('choose')}>Back</button>
        </div>
      </div>
    );
  }

  if (mode === 'password') {
    const prevMode = importInput ? 'import' : 'verify';
    return (
      <div className="setup-screen">
        <div className="setup-hero">
          <h1>Create <span className="accent">password</span></h1>
          <p>Your seed phrase will be encrypted with this password. You'll need it every time you open the wallet.</p>
        </div>
        <div style={{display:'flex',flexDirection:'column',gap:12}}>
          <div>
            <input
              type="password"
              placeholder="New password (min 8 chars)"
              value={newPassword}
              onChange={e=>{setNewPassword(e.target.value);setPasswordError('');}}
              autoComplete="new-password"
              style={{padding:'11px 14px',background:'var(--bg-input)',border:'1px solid var(--border)',
                borderRadius:'var(--radius)',color:'var(--text-primary)',fontSize:14,width:'100%',boxSizing:'border-box'}}
            />
            {(() => { const s = passwordStrength(newPassword); return s ? (
              <div style={{display:'flex',alignItems:'center',gap:6,marginTop:6}}>
                <div style={{flex:1,height:3,borderRadius:2,background:'var(--border)'}}>
                  <div style={{height:'100%',borderRadius:2,transition:'all 0.3s',
                    width: s.label==='Weak'?'33%':s.label==='Fair'?'66%':'100%',
                    background: s.color}}/>
                </div>
                <span style={{fontSize:10,color:s.color,fontWeight:600,minWidth:32}}>{s.label}</span>
              </div>
            ) : null; })()}
          </div>
          <input
            type="password"
            placeholder="Confirm password"
            value={confirmPassword}
            onChange={e=>{setConfirmPassword(e.target.value);setPasswordError('');}}
            onKeyDown={e=>{if(e.key==='Enter'&&!passwordBusy&&newPassword&&confirmPassword)handleCreatePassword();}}
            autoComplete="new-password"
            style={{padding:'11px 14px',background:'var(--bg-input)',border:'1px solid var(--border)',
              borderRadius:'var(--radius)',color:'var(--text-primary)',fontSize:14,width:'100%',boxSizing:'border-box'}}
          />
        </div>
        {passwordError && <div className="error-msg" style={{marginTop:8}}>{passwordError}</div>}
        <button className="btn btn-primary" style={{marginTop:16}} disabled={passwordBusy || !newPassword || !confirmPassword} onClick={handleCreatePassword}>
          {passwordBusy ? 'Encrypting…' : 'Create Wallet'}
        </button>
        <button className="btn btn-secondary mt-8" disabled={passwordBusy} onClick={()=>setMode(prevMode)}>← Back</button>
      </div>
    );
  }

  return (
    <div className="setup-screen">
      <div className="setup-hero" style={{marginTop:40}}>
        <div style={{fontSize:48,marginBottom:16}}>🌿</div>
        <h1>Chia <span className="accent">Wallet</span></h1>
        <p>Fast, reliable — powered by sync-verified nodes. No wait, no stale balances.</p>
      </div>
      <div className="btn-group">
        <button className="btn btn-primary" onClick={handleGenerate}>Create new wallet</button>
        <div className="divider">or</div>
        <button className="btn btn-secondary" onClick={()=>setMode('import')}>Import existing wallet</button>
        {onCancel && <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}

function WalletHome({ wallet, nodeUrl, refreshKey, onSendSuccess, hideSmallBalances, onCatBalancesChange }: {
  wallet: WalletState; nodeUrl: string; refreshKey: number; onSendSuccess: () => void;
  hideSmallBalances: boolean; onCatBalancesChange: (b: CatBalance[]) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [proxyError, setProxyError] = useState('');
  const [xchPrice, setXchPrice] = useState(0);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [catBalances, setCatBalances] = useState<CatBalance[]>([]);
  const [selectedCat, setSelectedCat] = useState<CatBalance | null>(null);
  const [consolidateOpen, setConsolidateOpen] = useState(false);
  const [consolidateFee, setConsolidateFee] = useState('0.001');
  const [consolidateStatus, setConsolidateStatus] = useState('');
  const [consolidateBusy, setConsolidateBusy] = useState(false);
  const primaryAddress = wallet.addresses[0]?.address || '';
  const hasLoadedRef = React.useRef(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const puzzleHashes = wallet.addresses.map(a => a.puzzleHashHex);
      const [result, xch] = await Promise.all([
        getBalance(nodeUrl, puzzleHashes),
        fetchXchPrice(),
      ]);
      setBalance(result.totalMojo);
      setXchPrice(xch);
      setProxyError('');
      hasLoadedRef.current = true;
      const cats = await getCatBalances(nodeUrl, puzzleHashes, xch);
      setCatBalances(cats);
      onCatBalancesChange(cats);
    } catch (e: any) {
      if (!hasLoadedRef.current) setProxyError('Cannot reach proxy server. Check your internet connection.');
    }
    finally { setLoading(false); }
  }, [nodeUrl, wallet.addresses]);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 30_000);
    return () => clearInterval(interval);
  }, [fetchAll, refreshKey]);

  // Keep selectedCat in sync with latest balance after refreshes
  useEffect(() => {
    if (selectedCat) {
      const updated = catBalances.find(c => c.assetId === selectedCat.assetId);
      if (updated) setSelectedCat(updated);
    }
  }, [catBalances]);

  const handleConsolidate = async () => {
    if (!balance || balance <= 0n || !primaryAddress) return;
    const feeMojo = BigInt(Math.round(parseFloat(consolidateFee || '0') * 1_000_000_000_000));
    if (feeMojo >= balance) { setConsolidateStatus('Fee exceeds balance'); return; }
    setConsolidateBusy(true);
    setConsolidateStatus('');
    try {
      const amountMojo = balance - feeMojo;
      const res = await walletRpc('send_transaction', {
        wallet_id: 1,
        address: primaryAddress,
        amount: amountMojo,
        fee: feeMojo,
        memos: ['consolidate'],
      });
      if (res.success) {
        setConsolidateStatus('Consolidation submitted');
        setConsolidateOpen(false);
        onSendSuccess();
      } else {
        setConsolidateStatus(res.error || 'Failed');
      }
    } catch (e: any) {
      setConsolidateStatus(e.message);
    } finally { setConsolidateBusy(false); }
  };

  const xchDisplay = balance !== null ? formatMojoToXch(balance) : null;
  const xchUsd = balance !== null && xchPrice > 0 ? Number(balance) / 1_000_000_000_000 * xchPrice : 0;
  const catUsd = catBalances.reduce((sum, c) => sum + (c.priceUsd > 0 ? c.priceUsd * Number(c.totalMojo) / 1000 : 0), 0);
  const portfolioUsd = xchUsd + catUsd;

  if (selectedCat) {
    return <CatDetailScreen token={selectedCat} onBack={() => setSelectedCat(null)} onSendSuccess={onSendSuccess} wallet={wallet} nodeUrl={nodeUrl}/>;
  }

  return (
    <div className="wallet-screen">
      {/* Balance card */}
      {proxyError && (
        <div style={{background:'rgba(220,50,50,0.1)',border:'1px solid #dc3232',
          borderRadius:8,padding:'10px 14px',fontSize:12,color:'#ff6b6b',marginBottom:4}}>
          {proxyError}
        </div>
      )}

      <div className="balance-card">
        <div className="balance-label">Total Balance</div>
        {loading && balance === null ? (
          <div className="balance-loading"><div className="spinner"/>
            {'Fetching balance…'}
          </div>
        ) : (
          <>
            <div className="balance-amount">{xchDisplay ?? '—'}<span className="balance-unit">XCH</span></div>
            {balance !== null && xchPrice > 0 && (
              <div style={{fontSize:20,color:'var(--text-secondary)',marginTop:4}}>
                ${xchUsd.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}
              </div>
            )}
            {catUsd > 0 && (
              <div style={{fontSize:13,color:'var(--text-secondary)',marginTop:8,
                borderTop:'1px solid var(--border)',paddingTop:8,display:'flex',justifyContent:'space-between'}}>
                <span>Portfolio total</span>
                <span style={{fontWeight:600,color:'var(--text-primary)'}}>
                  ${portfolioUsd.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}
                </span>
              </div>
            )}
          </>
        )}
      </div>

      {/* Assets */}
      <div className="section-label">Assets</div>

      {/* XCH row */}
      <div className="token-card">
        <div className="token-avatar" style={{background:'var(--accent)'}}>🌿</div>
        <div className="token-info">
          <div className="token-row">
            <span className="token-name">Chia</span>
            <span className="token-price">{xchPrice > 0 ? `$${xchPrice.toFixed(2)} / XCH` : '—'}</span>
          </div>
          <div className="token-ticker">XCH</div>
        </div>
      </div>

      {/* CAT tokens */}
      {loading && catBalances.length === 0 && (
        <div className="balance-loading"><div className="spinner"/>Scanning tokens…</div>
      )}
      {(() => {
        const visible = hideSmallBalances
          ? catBalances.filter(t => {
              if (t.priceUsd) return Number(t.totalMojo) / 1000 * t.priceUsd >= 0.01;
              return t.totalMojo >= 1000n;
            })
          : catBalances;
        const hidden = catBalances.length - visible.length;
        return (
          <>
            {visible.map(token => {
              const usdValue = token.priceUsd ? formatCatUsdValue(token.totalMojo, token.priceUsd) : null;
              return (
                <div key={token.assetId} className="token-card" style={{cursor:'pointer'}}
                  onClick={() => setSelectedCat(token)}>
                  <TokenAvatar ticker={token.ticker} logoUrl={token.logoUrl} />
                  <div className="token-info">
                    <div className="token-row">
                      <span className="token-name">{token.name}</span>
                      <span className="token-amount">{formatCatAmount(token.totalMojo)}</span>
                    </div>
                    <div className="token-row" style={{marginTop:2}}>
                      <span className="token-ticker">{token.ticker}</span>
                      <span className="token-price">{usdValue || ''}</span>
                    </div>
                  </div>
                </div>
              );
            })}
            {hidden > 0 && (
              <div style={{fontSize:12,color:'var(--text-secondary)',textAlign:'center',padding:'6px 0'}}>
                {hidden} small balance{hidden > 1 ? 's' : ''} hidden
              </div>
            )}
          </>
        );
      })()}

      {/* Consolidate UTXOs */}
      {balance !== null && balance > 0n && !consolidateOpen && (
        <button onClick={() => { setConsolidateOpen(true); setConsolidateStatus(''); }}
          style={{background:'none',border:'none',color:'var(--text-secondary)',fontSize:12,
            cursor:'pointer',padding:'4px 0',textDecoration:'underline',textAlign:'left'}}>
          Consolidate coins
        </button>
      )}
      {consolidateOpen && (
        <div style={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius)',
          padding:'14px',marginTop:4}}>
          <div style={{fontSize:12,color:'var(--text-secondary)',marginBottom:10}}>
            Merges all XCH UTXOs into one by sending your full balance back to yourself.
          </div>
          <label style={{fontSize:11,color:'var(--text-secondary)',display:'block',marginBottom:4}}>Fee (XCH)</label>
          <input
            type="number" step="0.0001" min="0"
            value={consolidateFee}
            onChange={e=>{setConsolidateFee(e.target.value);setConsolidateStatus('');}}
            style={{width:'100%',boxSizing:'border-box',padding:'9px 12px',background:'var(--bg-input)',
              border:'1px solid var(--border)',borderRadius:'var(--radius-sm)',
              color:'var(--text-primary)',fontSize:14,marginBottom:10}}
          />
          {consolidateStatus && (
            <div style={{fontSize:12,color: consolidateStatus.includes('submitted') ? 'var(--accent)' : '#ff6b6b',marginBottom:8}}>
              {consolidateStatus}
            </div>
          )}
          <div style={{display:'flex',gap:8}}>
            <button className="btn btn-primary" style={{flex:1,padding:'8px 0',fontSize:13}}
              disabled={consolidateBusy} onClick={handleConsolidate}>
              {consolidateBusy ? 'Sending…' : 'Consolidate'}
            </button>
            <button className="btn btn-secondary" style={{flex:1,padding:'8px 0',fontSize:13}}
              onClick={() => setConsolidateOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ReceiveScreen({ wallet }: { wallet: WalletState }) {
  const [copied, setCopied] = useState<number|null>(null);
  const [showAll, setShowAll] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const handleCopy = (address: string, index: number) => {
    navigator.clipboard.writeText(address); setCopied(index); setTimeout(()=>setCopied(null),2000);
  };
  const displayed = showAll ? wallet.addresses : wallet.addresses.slice(0, 3);
  const selectedAddress = wallet.addresses[selectedIndex]?.address || '';

  return (
    <div className="wallet-screen">
      <div className="section-label">Receive</div>

      {selectedAddress && (
        <div style={{display:'flex',flexDirection:'column',alignItems:'center',
          background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:16,
          padding:'20px 16px',gap:12}}>
          <div style={{background:'#f0f2f8',borderRadius:12,padding:12,display:'inline-flex'}}>
            <QRCodeSVG value={selectedAddress} size={200} fgColor="#0a0b0f" bgColor="#f0f2f8"/>
          </div>
          <div style={{fontSize:10,color:'var(--text-secondary)',fontFamily:'var(--font-mono)',
            wordBreak:'break-all',textAlign:'center',lineHeight:1.5}}>
            {selectedAddress}
          </div>
          <button className={`copy-btn ${copied===selectedIndex?'copied':''}`}
            onClick={()=>handleCopy(selectedAddress,selectedIndex)}
            style={{fontSize:12,padding:'7px 18px'}}>
            {copied===selectedIndex?'✓ Copied!':'Copy Address'}
          </button>
        </div>
      )}

      <div className="section-label" style={{marginTop:8}}>All addresses</div>
      <div style={{fontSize:12,color:'var(--text-secondary)',lineHeight:1.6}}>
        Any of these addresses belong to your wallet. Tap to show QR.
      </div>
      <div className="receive-list">
        {displayed.map(addr => (
          <div className={`address-card ${selectedIndex===addr.index?'selected-address':''}`}
            key={addr.index}
            onClick={()=>setSelectedIndex(addr.index)}
            style={{cursor:'pointer',border:`1px solid ${selectedIndex===addr.index?'var(--accent)':'var(--border)'}`}}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:10,color:'var(--text-dim)',marginBottom:4,fontFamily:'var(--font-mono)'}}>Address #{addr.index}</div>
              <div className="address-text" style={{fontSize:10,wordBreak:'break-all'}}>{addr.address}</div>
            </div>
            <button className={`copy-btn ${copied===addr.index?'copied':''}`}
              onClick={e=>{e.stopPropagation();handleCopy(addr.address,addr.index);}}>
              {copied===addr.index?'✓':'Copy'}
            </button>
          </div>
        ))}
        {!showAll && wallet.addresses.length > 3 && (
          <button onClick={()=>setShowAll(true)} style={{
            background:'none',border:'1px solid var(--border)',borderRadius:'var(--radius)',
            color:'var(--text-secondary)',fontSize:12,padding:'10px',cursor:'pointer',
            transition:'all 0.15s'
          }}>
            Show more addresses ({wallet.addresses.length - 3} more)
          </button>
        )}
      </div>
    </div>
  );
}

const NODE_URL = 'https://wiznerd.fun/proxy';

function passwordStrength(pw: string): { label: string; color: string } | null {
  if (!pw) return null;
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw) && /[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (score <= 1) return { label: 'Weak', color: '#ff6b6b' };
  if (score === 2) return { label: 'Fair', color: '#e07b3a' };
  return { label: 'Strong', color: '#f97316' };
}

function SettingsScreen({ onRemoveWallet, onSwitchWallet, onRenameWallet, onAddWallet, walletList, activeWalletId, addressBook, onAddEntry, onRemoveEntry, hideSmallBalances, onToggleHideSmall, currentMnemonic, idleLockMinutes, onIdleLockChange, sessionKey: _sessionKey, onChangePassword }:
  { onRemoveWallet:(id:string)=>void; onSwitchWallet:(id:string)=>void;
    onRenameWallet:(id:string,name:string)=>void; onAddWallet:()=>void;
    walletList: WalletEntry[]; activeWalletId: string|null;
    addressBook: AddressEntry[]; onAddEntry:(label:string,address:string)=>void; onRemoveEntry:(id:string)=>void;
    hideSmallBalances: boolean; onToggleHideSmall:(v:boolean)=>void;
    currentMnemonic: string;
    idleLockMinutes: number; onIdleLockChange:(minutes:number)=>void;
    sessionKey: CryptoKey|null; onChangePassword:(newKey:CryptoKey,updatedWallets:WalletEntry[])=>void;
  }) {
  const [newLabel, setNewLabel] = useState('');
  const [newAddress, setNewAddress] = useState('');
  const [addError, setAddError] = useState('');
  const [confirmRemoveId, setConfirmRemoveId] = useState<string|null>(null);
  const [editingNameId, setEditingNameId] = useState<string|null>(null);
  const [editingName, setEditingName] = useState('');
  const [customTokens, setCustomTokens] = useState<string[]>(() => loadCustomAssetIds());
  const [newAssetId, setNewAssetId] = useState('');
  const [assetIdError, setAssetIdError] = useState('');
  const [showMnemonic, setShowMnemonic] = useState(false);
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwError, setPwError] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwSuccess, setPwSuccess] = useState(false);

  const handleChangePasswordSubmit = async () => {
    if (!currentPw) { setPwError('Enter your current password'); return; }
    if (newPw.length < 8) { setPwError('New password must be at least 8 characters'); return; }
    if (newPw !== confirmPw) { setPwError('Passwords do not match'); return; }
    setPwBusy(true); setPwError(''); setPwSuccess(false);
    try {
      // Verify current password by re-deriving and decrypting a test wallet
      const saltB64 = localStorage.getItem(VAULT_SALT_KEY) || '';
      const currentKey = await deriveKey(currentPw, saltB64);
      const testWallet = walletList.find(w => w.encryptedMnemonic);
      if (testWallet) await decryptMnemonic(testWallet.encryptedMnemonic!, currentKey);

      // Generate new salt but DO NOT store yet — only commit after successful re-encryption
      const newSaltB64 = generateSalt();
      const newKey = await deriveKey(newPw, newSaltB64);

      const results = await Promise.allSettled(
        walletList.map(async w => {
          if (!w.encryptedMnemonic) return w;
          const mnemonic = await decryptMnemonic(w.encryptedMnemonic, currentKey);
          return { ...w, encryptedMnemonic: await encryptMnemonic(mnemonic, newKey) };
        })
      );
      const failures = results.filter(r => r.status === 'rejected').length;
      if (failures > 0) throw new Error(`Failed to re-encrypt ${failures} wallet(s)`);

      const updated = results.map(r => (r as PromiseFulfilledResult<WalletEntry>).value);

      // Atomically commit new salt then update state
      storeSalt(newSaltB64);
      onChangePassword(newKey, updated);
      setCurrentPw(''); setNewPw(''); setConfirmPw(''); setPwSuccess(true);
    } catch (e: any) {
      const msg = e.message || '';
      if (msg.includes('OperationError') || msg.includes('decrypt') || msg.includes('The operation failed')) {
        setPwError('Current password is incorrect');
      } else {
        setPwError(`Failed: ${msg}`);
      }
    } finally { setPwBusy(false); }
  };

  const handleAddEntry = () => {
    setAddError('');
    if (!newLabel.trim()) { setAddError('Label required'); return; }
    if (!isValidXchAddress(newAddress.trim())) { setAddError('Invalid XCH address'); return; }
    onAddEntry(newLabel.trim(), newAddress.trim());
    setNewLabel(''); setNewAddress('');
  };

  return (
    <div className="wallet-screen">
      <div className="section-label">Display</div>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',
        background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius)',
        padding:'12px 14px'}}>
        <div>
          <div style={{fontSize:13,fontWeight:600,color:'var(--text-primary)'}}>Hide small balances</div>
          <div style={{fontSize:11,color:'var(--text-secondary)',marginTop:2}}>Hide tokens worth less than $0.01</div>
        </div>
        <button
          onClick={() => onToggleHideSmall(!hideSmallBalances)}
          style={{
            width:44,height:24,borderRadius:12,border:'none',cursor:'pointer',
            background: hideSmallBalances ? 'var(--accent)' : 'var(--border)',
            position:'relative',transition:'background 0.2s',flexShrink:0,
          }}
        >
          <div style={{
            position:'absolute',top:3,left: hideSmallBalances ? 23 : 3,
            width:18,height:18,borderRadius:'50%',background:'#fff',transition:'left 0.2s',
          }}/>
        </button>
      </div>
      <div className="section-label mt-16">Address Book</div>
      {addressBook.length === 0 && (
        <div style={{fontSize:12,color:'var(--text-secondary)',padding:'8px 0'}}>No saved addresses.</div>
      )}
      {addressBook.map(entry => (
        <div className="address-card" key={entry.id}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:12,fontWeight:600,color:'var(--text-primary)',marginBottom:3}}>{entry.label}</div>
            <div className="address-text" style={{fontSize:10}}>{entry.address}</div>
          </div>
          <button className="copy-btn" onClick={()=>onRemoveEntry(entry.id)}
            style={{color:'var(--error)',borderColor:'rgba(224,92,92,0.4)',flexShrink:0}}>
            Remove
          </button>
        </div>
      ))}
      <div className="node-config">
        <div style={{fontSize:11,color:'var(--text-secondary)',letterSpacing:'0.06em'}}>ADD ADDRESS</div>
        <input type="text" placeholder="Label (e.g. Exchange)" value={newLabel}
          onChange={e=>{setNewLabel(e.target.value);setAddError('');}}/>
        <input type="text" placeholder="xch1…" value={newAddress}
          onChange={e=>{setNewAddress(e.target.value.trim());setAddError('');}}
          style={{fontFamily:'var(--font-mono)',fontSize:11}}/>
        {addError && <div className="error-msg">{addError}</div>}
        <button className="btn btn-secondary" style={{padding:'10px'}} onClick={handleAddEntry}>
          + Save Address
        </button>
      </div>

      <div className="section-label mt-16">Custom Tokens</div>
      <div style={{fontSize:12,color:'var(--text-secondary)',lineHeight:1.6,marginBottom:8}}>
        Pin a token by asset ID to scan for it directly, bypassing hint-based discovery.
        Useful for tokens received via direct issuance or from wallets that don't set hints.
      </div>
      {customTokens.length > 0 && customTokens.map(id => (
        <div className="address-card" key={id}>
          <div style={{flex:1,minWidth:0}}>
            <div className="address-text" style={{fontSize:10}}>{id}</div>
          </div>
          <button className="copy-btn"
            style={{color:'var(--error)',borderColor:'rgba(224,92,92,0.4)',flexShrink:0}}
            onClick={() => {
              const next = customTokens.filter(t => t !== id);
              setCustomTokens(next);
              saveCustomAssetIds(next);
            }}>
            Remove
          </button>
        </div>
      ))}
      <div className="node-config">
        <div style={{fontSize:11,color:'var(--text-secondary)',letterSpacing:'0.06em'}}>ADD TOKEN BY ASSET ID</div>
        <input type="text" placeholder="64-char hex asset ID"
          value={newAssetId}
          onChange={e => { setNewAssetId(e.target.value.trim()); setAssetIdError(''); }}
          style={{fontFamily:'var(--font-mono)',fontSize:11}}/>
        {assetIdError && <div className="error-msg">{assetIdError}</div>}
        <button className="btn btn-secondary" style={{padding:'10px'}} onClick={() => {
          const id = newAssetId.toLowerCase().replace(/^0x/, '');
          if (!/^[0-9a-f]{64}$/.test(id)) { setAssetIdError('Must be a 64-char hex asset ID'); return; }
          if (customTokens.includes(id)) { setAssetIdError('Already pinned'); return; }
          const next = [...customTokens, id];
          setCustomTokens(next);
          saveCustomAssetIds(next);
          setNewAssetId('');
        }}>
          + Pin Token
        </button>
      </div>

      <div className="section-label mt-16">Wallets</div>
      {walletList.map(entry => (
        <div key={entry.id} className="address-card" style={{flexDirection:'column',alignItems:'stretch',gap:8}}>
          {editingNameId === entry.id ? (
            <div style={{display:'flex',gap:8}}>
              <input
                type="text"
                value={editingName}
                onChange={e => setEditingName(e.target.value)}
                style={{flex:1,padding:'6px 10px',background:'var(--bg-input)',border:'1px solid var(--border)',
                  borderRadius:'var(--radius-sm)',color:'var(--text-primary)',fontSize:13}}
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Enter') { onRenameWallet(entry.id, editingName.trim() || entry.name); setEditingNameId(null); }
                  if (e.key === 'Escape') setEditingNameId(null);
                }}
              />
              <button className="copy-btn" onClick={() => { onRenameWallet(entry.id, editingName.trim() || entry.name); setEditingNameId(null); }}>Save</button>
              <button className="copy-btn" style={{color:'var(--text-secondary)'}} onClick={() => setEditingNameId(null)}>Cancel</button>
            </div>
          ) : (
            <div style={{display:'flex',alignItems:'center',gap:8}}>
              <div style={{flex:1,fontSize:13,fontWeight:600,color:'var(--text-primary)'}}>{entry.name}</div>
              {entry.id === activeWalletId && (
                <span style={{fontSize:10,background:'var(--accent)',color:'#000',borderRadius:4,padding:'2px 6px',fontWeight:700}}>ACTIVE</span>
              )}
              <button className="copy-btn" style={{fontSize:11}} onClick={() => { setEditingNameId(entry.id); setEditingName(entry.name); }}>Rename</button>
              {entry.id !== activeWalletId && (
                <button className="copy-btn" style={{fontSize:11}} onClick={() => onSwitchWallet(entry.id)}>Switch</button>
              )}
              {confirmRemoveId === entry.id ? (
                <>
                  <button className="copy-btn" style={{color:'var(--error)',borderColor:'rgba(224,92,92,0.4)',fontSize:11}}
                    onClick={() => { onRemoveWallet(entry.id); setConfirmRemoveId(null); }}>Confirm</button>
                  <button className="copy-btn" style={{fontSize:11}} onClick={() => setConfirmRemoveId(null)}>Cancel</button>
                </>
              ) : (
                <button className="copy-btn" style={{color:'var(--error)',borderColor:'rgba(224,92,92,0.4)',fontSize:11}}
                  onClick={() => setConfirmRemoveId(entry.id)}>Remove</button>
              )}
            </div>
          )}
        </div>
      ))}
      <button className="btn btn-secondary" style={{marginTop:4}} onClick={onAddWallet}>
        + Add wallet
      </button>

      <div className="section-label mt-16">Security</div>

      <div style={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius)',padding:'12px 14px',marginBottom:8}}>
        <div style={{fontSize:13,fontWeight:600,color:'var(--text-primary)',marginBottom:4}}>Auto-lock after inactivity</div>
        <div style={{fontSize:11,color:'var(--text-secondary)',marginBottom:10}}>
          Lock the wallet when idle. Requires password re-entry to unlock.
        </div>
        <select
          value={idleLockMinutes}
          onChange={e=>onIdleLockChange(Number(e.target.value))}
          style={{padding:'9px 12px',background:'var(--bg-input)',border:'1px solid var(--border)',
            borderRadius:'var(--radius)',color:'var(--text-primary)',fontSize:13,width:'100%',cursor:'pointer'}}>
          <option value={0}>Never</option>
          <option value={5}>5 minutes</option>
          <option value={15}>15 minutes</option>
          <option value={30}>30 minutes</option>
          <option value={60}>1 hour</option>
        </select>
      </div>

      <div style={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius)',padding:'12px 14px',marginBottom:8}}>
        <div style={{fontSize:13,fontWeight:600,color:'var(--text-primary)',marginBottom:4}}>Change password</div>
        <div style={{fontSize:11,color:'var(--text-secondary)',marginBottom:10}}>
          Re-encrypts all wallets with a new password. Takes effect immediately.
        </div>
        {pwSuccess && (
          <div style={{fontSize:12,color:'var(--accent)',marginBottom:8}}>✓ Password changed successfully</div>
        )}
        <div style={{display:'flex',flexDirection:'column',gap:8}}>
          <input type="password" placeholder="Current password" value={currentPw}
            onChange={e=>{setCurrentPw(e.target.value);setPwError('');setPwSuccess(false);}}
            style={{padding:'9px 12px',background:'var(--bg-input)',border:'1px solid var(--border)',
              borderRadius:'var(--radius)',color:'var(--text-primary)',fontSize:13,width:'100%',boxSizing:'border-box'}}/>
          <div>
            <input type="password" placeholder="New password (min 8 chars)" value={newPw}
              onChange={e=>{setNewPw(e.target.value);setPwError('');setPwSuccess(false);}}
              style={{padding:'9px 12px',background:'var(--bg-input)',border:'1px solid var(--border)',
                borderRadius:'var(--radius)',color:'var(--text-primary)',fontSize:13,width:'100%',boxSizing:'border-box'}}/>
            {(() => { const s = passwordStrength(newPw); return s ? (
              <div style={{display:'flex',alignItems:'center',gap:6,marginTop:5}}>
                <div style={{flex:1,height:3,borderRadius:2,background:'var(--border)'}}>
                  <div style={{height:'100%',borderRadius:2,transition:'all 0.3s',
                    width: s.label==='Weak'?'33%':s.label==='Fair'?'66%':'100%',
                    background: s.color}}/>
                </div>
                <span style={{fontSize:10,color:s.color,fontWeight:600,minWidth:32}}>{s.label}</span>
              </div>
            ) : null; })()}
          </div>
          <input type="password" placeholder="Confirm new password" value={confirmPw}
            onChange={e=>{setConfirmPw(e.target.value);setPwError('');setPwSuccess(false);}}
            onKeyDown={e=>{if(e.key==='Enter'&&!pwBusy&&currentPw&&newPw&&confirmPw)handleChangePasswordSubmit();}}
            style={{padding:'9px 12px',background:'var(--bg-input)',border:'1px solid var(--border)',
              borderRadius:'var(--radius)',color:'var(--text-primary)',fontSize:13,width:'100%',boxSizing:'border-box'}}/>
        </div>
        {pwError && <div className="error-msg" style={{marginTop:6}}>{pwError}</div>}
        <button className="btn btn-secondary" style={{padding:'9px',marginTop:8}}
          disabled={pwBusy || !currentPw || !newPw || !confirmPw} onClick={handleChangePasswordSubmit}>
          {pwBusy ? 'Encrypting…' : 'Change password'}
        </button>
      </div>

      <div style={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius)',padding:'12px 14px'}}>
        <div style={{fontSize:13,fontWeight:600,color:'var(--text-primary)',marginBottom:4}}>Reveal seed phrase</div>
        <div style={{fontSize:11,color:'var(--text-secondary)',marginBottom:10}}>
          Your 24-word seed phrase is the only way to recover this wallet. Never share it.
        </div>
        {!showMnemonic ? (
          <button
            onClick={() => setShowMnemonic(true)}
            style={{padding:'8px 14px',background:'none',border:'1px solid rgba(224,92,92,0.5)',
              borderRadius:'var(--radius-sm)',color:'var(--error)',fontSize:12,cursor:'pointer',fontWeight:600}}>
            Show seed phrase
          </button>
        ) : (
          <div>
            <div style={{background:'rgba(224,92,92,0.07)',border:'1px solid rgba(224,92,92,0.3)',
              borderRadius:'var(--radius-sm)',padding:'10px 12px',marginBottom:8}}>
              <div style={{fontSize:10,color:'var(--error)',fontWeight:700,marginBottom:8}}>
                ⚠️ KEEP THIS PRIVATE — anyone with these words controls your funds
              </div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:4}}>
                {currentMnemonic.split(' ').map((word, i) => (
                  <div key={i} style={{fontSize:11,color:'var(--text-primary)',fontFamily:'var(--font-mono)',
                    background:'var(--bg-input)',borderRadius:4,padding:'4px 6px'}}>
                    <span style={{color:'var(--text-secondary)',marginRight:4,fontSize:9}}>{i+1}.</span>{word}
                  </div>
                ))}
              </div>
            </div>
            <div style={{display:'flex',gap:8}}>
              <button
                onClick={() => navigator.clipboard.writeText(currentMnemonic)}
                style={{padding:'7px 12px',background:'none',border:'1px solid var(--border)',
                  borderRadius:'var(--radius-sm)',color:'var(--text-secondary)',fontSize:11,cursor:'pointer'}}>
                Copy
              </button>
              <button
                onClick={() => setShowMnemonic(false)}
                style={{padding:'7px 12px',background:'none',border:'1px solid var(--border)',
                  borderRadius:'var(--radius-sm)',color:'var(--text-secondary)',fontSize:11,cursor:'pointer'}}>
                Hide
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Token avatar — colored circle with ticker initials, or actual logo
function TokenAvatar({ ticker, logoUrl }: { ticker: string; logoUrl?: string }) {
  const [imgFailed, setImgFailed] = useState(false);
  const colors = [
    '#f97316', '#e07b3a', '#7b6fd8', '#d85c8a',
    '#5ca8d8', '#d8c25c', '#8ad85c', '#d85c5c'
  ];
  const color = colors[ticker.charCodeAt(0) % colors.length];

  if (logoUrl && !imgFailed) {
    return (
      <img
        src={logoUrl}
        alt={ticker}
        style={{ width: 40, height: 40, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
        onError={() => setImgFailed(true)}
      />
    );
  }

  return (
    <div style={{
      width: 40, height: 40, borderRadius: '50%',
      background: color, display: 'flex', alignItems: 'center',
      justifyContent: 'center', fontSize: 13, fontWeight: 700,
      color: '#0a0b0f', flexShrink: 0, letterSpacing: '-0.02em'
    }}>
      {ticker.slice(0, 2).toUpperCase()}
    </div>
  );
}


const WALLET_PROXY_URL = 'https://wiznerd.fun/proxy';
let WALLET_PROXY = (() => {
  // Migrate away from any locally stored proxy URL — always use the hosted proxy.
  try { localStorage.removeItem('chia_proxy_url'); } catch {}
  return WALLET_PROXY_URL;
})();

function serializeJSON(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(serializeJSON).join(',')}]`;
  if (typeof v === 'object') {
    const pairs = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .map(([k, val]) => `${JSON.stringify(k)}:${serializeJSON(val)}`);
    return `{${pairs.join(',')}}`;
  }
  return JSON.stringify(v);
}

async function walletRpc(endpoint: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${WALLET_PROXY}/wallet/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: serializeJSON(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Wallet RPC ${endpoint} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

// Module-level cache for daemon wallet list (30s TTL)
let _catWalletCache: { wallets: any[]; ts: number } | null = null;

async function getDaemonWallets(): Promise<any[]> {
  if (_catWalletCache && Date.now() - _catWalletCache.ts < 30_000) return _catWalletCache.wallets;
  try {
    const res = await walletRpc('get_wallets', { include_data: true });
    if (res.success) {
      _catWalletCache = { wallets: res.wallets || [], ts: Date.now() };
      return _catWalletCache.wallets;
    }
  } catch { /* fall through */ }
  return [];
}

// Returns the wallet daemon wallet_id for a CAT assetId, or null if not registered
async function getCatWalletId(assetId: string): Promise<number | null> {
  try {
    const wallets = await getDaemonWallets();
    const match = wallets.find(
      (w: any) => w.type === 6 && (w.data || '').toLowerCase() === assetId.toLowerCase()
    );
    return match?.id ?? null;
  } catch { return null; }
}

function CatDetailScreen({ token, onBack, onSendSuccess, wallet, nodeUrl }: {
  token: CatBalance; onBack: () => void; onSendSuccess: () => void;
  wallet: WalletState; nodeUrl: string;
}) {
  const [catWalletId, setCatWalletId] = useState<number | null>(null);
  const [loadingWallet, setLoadingWallet] = useState(true);
  const [toAddress, setToAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [fee, setFee] = useState('0.00005');
  const [status, setStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [showBook, setShowBook] = useState(false);
  const addressBook: AddressEntry[] = React.useMemo(() => {
    try { return JSON.parse(localStorage.getItem('chia_address_book') || '[]'); }
    catch { return []; }
  }, []);
  const sendingRef = React.useRef(false);

  useEffect(() => {
    getCatWalletId(token.assetId)
      .then(id => setCatWalletId(id))
      .finally(() => setLoadingWallet(false));
  }, [token.assetId]);

  const isValidAddr = isValidXchAddress(toAddress);
  // CAT v2: 1 token = 1000 mojos. Guard against NaN before BigInt conversion.
  const amountFloat = parseFloat(amount || '0');
  const feeFloat = parseFloat(fee || '0');
  const amountMojo = BigInt(isNaN(amountFloat) ? 0 : Math.round(amountFloat * 1000));
  const feeMojo = BigInt(isNaN(feeFloat) ? 0 : Math.round(feeFloat * 1_000_000_000_000));
  const isValid = isValidAddr && amountMojo > BigInt(0) && amountMojo <= token.totalMojo;

  const handleMax = () => {
    const whole = token.totalMojo / BigInt(1000);
    const frac = token.totalMojo % BigInt(1000);
    const fracStr = frac === BigInt(0) ? '' : '.' + frac.toString().padStart(3, '0').replace(/0+$/, '');
    setAmount(`${whole}${fracStr}`);
  };

  async function handleSend() {
    if (!isValid || sendingRef.current) return;
    sendingRef.current = true;
    setStatus('sending');
    setMessage('');
    try {
      if (catWalletId !== null) {
        // Daemon path: use cat_spend for registered tokens
        const body = `{"wallet_id":${catWalletId},"inner_address":${JSON.stringify(toAddress)},"amount":${amountMojo},"fee":${feeMojo}}`;
        const res = await fetch(`${WALLET_PROXY}/wallet/cat_spend`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(30000),
        });
        const data = await res.json();
        if (data.success) {
          addPendingTx({ id: crypto.randomUUID(), type: 'sent', amount,
            amountMojo: amountMojo.toString(), ticker: token.ticker, isCat: true,
            submittedAt: Date.now(), expiresAt: Date.now() + 5 * 60 * 1000 });
          setStatus('success');
          setMessage(`Sent ${amount} ${token.ticker}`);
          setToAddress('');
          setAmount('');
          onSendSuccess();
        } else {
          setStatus('error');
          setMessage(data.error || 'Transaction failed');
        }
      } else {
        // Manual path: build CAT spend bundle directly (no daemon registration needed)
        const spendCoin = token.coins.find(c => BigInt(c.amount) >= amountMojo);
        if (!spendCoin) {
          setStatus('error');
          setMessage('No single coin covers this amount. Consolidate coins in the Chia GUI first.');
          return;
        }
        const { sendCatManual } = await import('./lib/cat_spend');
        await sendCatManual(nodeUrl, spendCoin, amountMojo, toAddress, wallet.addresses);
        setStatus('success');
        setMessage(`Sent ${amount} ${token.ticker} (0 fee)`);
        setToAddress('');
        setAmount('');
        onSendSuccess();
      }
    } catch (e: any) {
      setStatus('error');
      setMessage(e.message);
    } finally {
      sendingRef.current = false;
    }
  }

  return (
    <div className="wallet-screen">
      <button onClick={onBack} style={{
        background:'none',border:'none',color:'var(--accent)',
        fontSize:13,cursor:'pointer',textAlign:'left',padding:0,marginBottom:4,
      }}>← Back</button>

      <div style={{display:'flex',alignItems:'center',gap:14,background:'var(--bg-card)',
        border:'1px solid var(--border)',borderRadius:16,padding:'16px'}}>
        <TokenAvatar ticker={token.ticker} logoUrl={token.logoUrl}/>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontWeight:700,fontSize:18,color:'var(--text-primary)'}}>{token.name}</div>
          <div style={{fontSize:12,color:'var(--accent)',marginTop:2}}>{token.ticker}</div>
        </div>
      </div>

      <div style={{background:'var(--bg-card)',border:'1px solid var(--border)',
        borderRadius:12,padding:'14px 16px'}}>
        <div style={{fontSize:11,color:'var(--text-secondary)',letterSpacing:'0.06em',marginBottom:6}}>BALANCE</div>
        <div style={{fontSize:24,fontWeight:700,color:'var(--text-primary)'}}>
          {formatCatAmount(token.totalMojo)}
          <span style={{fontSize:14,color:'var(--accent)',marginLeft:6}}>{token.ticker}</span>
        </div>
        {token.priceUsd > 0 && (
          <div style={{fontSize:14,color:'var(--text-secondary)',marginTop:4}}>
            {formatCatUsdValue(token.totalMojo, token.priceUsd)}
          </div>
        )}
      </div>

      {token.isCat1 && (
        <div style={{background:'rgba(255,160,0,0.08)',border:'1px solid rgba(255,160,0,0.4)',
          borderRadius:8,padding:'10px 14px',fontSize:12,color:'rgba(255,160,0,0.9)'}}>
          Legacy CAT1 token — this token was issued under the original CAT standard before
          the 2022 upgrade. Viewing balance is supported, but sends require the Chia reference wallet.
        </div>
      )}

      {!token.isCat1 && !loadingWallet && catWalletId === null && (
        <div style={{background:'rgba(249,115,22,0.07)',border:'1px solid var(--accent)',
          borderRadius:8,padding:'8px 12px',fontSize:11,color:'var(--accent)'}}>
          Direct chain send — no wallet daemon registration required. Fee: 0 XCH.
        </div>
      )}

      {!token.isCat1 && (loadingWallet ? (
        <div className="balance-loading"><div className="spinner"/>Checking wallet daemon…</div>
      ) : (
        <div style={{display:'flex',flexDirection:'column',gap:12}}>
          <div>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
              <div style={{fontSize:11,color:'var(--text-secondary)',letterSpacing:'0.08em'}}>TO ADDRESS</div>
              {addressBook.length > 0 && (
                <button onClick={()=>setShowBook(b=>!b)}
                  style={{background:'none',border:'none',color:'var(--accent)',fontSize:11,cursor:'pointer',padding:0}}>
                  {showBook ? 'Hide book' : '📋 Address book'}
                </button>
              )}
            </div>
            <input
              className="address-input"
              style={{width:'100%',boxSizing:'border-box',padding:'10px 12px',fontSize:12,fontFamily:'var(--font-mono)'}}
              placeholder="xch1…"
              value={toAddress}
              onChange={e => setToAddress(e.target.value.trim())}
              spellCheck={false}
            />
            {showBook && addressBook.length > 0 && (
              <div style={{marginTop:6,display:'flex',flexDirection:'column',gap:4}}>
                {addressBook.map(entry => (
                  <button key={entry.id}
                    onClick={()=>{ setToAddress(entry.address); setShowBook(false); }}
                    style={{display:'flex',justifyContent:'space-between',alignItems:'center',
                      background:'var(--bg-input)',border:'1px solid var(--border)',
                      borderRadius:'var(--radius-sm)',padding:'8px 12px',cursor:'pointer',
                      textAlign:'left',gap:8}}>
                    <span style={{fontSize:12,fontWeight:600,color:'var(--text-primary)',flexShrink:0}}>
                      {entry.label}
                    </span>
                    <span style={{fontSize:10,color:'var(--text-dim)',fontFamily:'var(--font-mono)',
                      overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                      {entry.address.slice(0,10)}…{entry.address.slice(-6)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div style={{display:'grid',gridTemplateColumns: catWalletId !== null ? '1fr 1fr' : '1fr',gap:10}}>
            <div>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                <div style={{fontSize:11,color:'var(--text-secondary)',letterSpacing:'0.08em'}}>AMOUNT ({token.ticker})</div>
                {token.totalMojo > BigInt(0) && (
                  <button onClick={handleMax}
                    style={{background:'none',border:'none',color:'var(--accent)',fontSize:11,cursor:'pointer',padding:0}}>
                    Max
                  </button>
                )}
              </div>
              <input
                className="address-input"
                style={{width:'100%',boxSizing:'border-box',padding:'10px 12px',fontSize:14}}
                placeholder="0.000"
                type="number" min="0" step="0.001"
                value={amount}
                onChange={e => setAmount(e.target.value)}
              />
            </div>
            {catWalletId !== null && <div>
              <div style={{fontSize:11,color:'var(--text-secondary)',letterSpacing:'0.08em',marginBottom:6}}>FEE (XCH)</div>
              <input
                className="address-input"
                style={{width:'100%',boxSizing:'border-box',padding:'10px 12px',fontSize:14}}
                placeholder="0.00005"
                type="number" min="0" step="0.00001"
                value={fee}
                onChange={e => setFee(e.target.value)}
              />
            </div>}
          </div>

          <button
            onClick={handleSend}
            disabled={!isValid || status === 'sending'}
            style={{
              padding:'14px',
              background: isValid && status !== 'sending' ? 'var(--accent)' : 'var(--bg-card)',
              color: isValid && status !== 'sending' ? '#0a0b0f' : 'var(--text-dim)',
              border:'1px solid var(--border)',borderRadius:'var(--radius)',
              fontWeight:700,fontSize:15,
              cursor: isValid && status !== 'sending' ? 'pointer' : 'not-allowed',
              transition:'all 0.2s',
            }}
          >
            {status === 'sending' ? '⏳ Sending…' : `➤ Send ${token.ticker}`}
          </button>

          {status === 'success' && (
            <div style={{padding:'12px',background:'rgba(249,115,22,0.1)',
              border:'1px solid var(--accent)',borderRadius:8,fontSize:13,color:'var(--accent)'}}>
              ✓ {message}
            </div>
          )}
          {status === 'error' && (
            <div style={{padding:'12px',background:'rgba(220,50,50,0.1)',
              border:'1px solid #dc3232',borderRadius:8,fontSize:13,color:'#ff6b6b'}}>
              ✗ {message}
            </div>
          )}
        </div>
      ))}

      <div style={{fontSize:10,color:'var(--text-dim)',fontFamily:'var(--font-mono)',
        wordBreak:'break-all',paddingTop:10,borderTop:'1px solid var(--border)'}}>
        Asset ID: {token.assetId}
      </div>
    </div>
  );
}

async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    results.push(...await Promise.all(batch.map(fn)));
  }
  return results;
}



function HistoryScreen({ wallet, nodeUrl, catBalances }: {
  wallet: WalletState; nodeUrl: string; catBalances: CatBalance[];
}) {
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCount, setShowCount] = useState(50);
  const [pendingTxs, setPendingTxs] = useState<PendingTx[]>(() =>
    loadPendingTxs().filter(t => Date.now() < t.expiresAt)
  );
  const [clawbacks, setClawbacks] = useState<ClawbackEntry[]>(() =>
    loadClawbacks().filter(e => Date.now() < e.expiresAt)
  );
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [cancelMsg, setCancelMsg] = useState<Record<string, string>>({});
  const [expandedTxId, setExpandedTxId] = useState<string | null>(null);

  async function handleCancelClawback(entry: ClawbackEntry) {
    setCancellingId(entry.txId);
    try {
      const txRes = await walletRpc('get_transaction', { transaction_id: entry.txId });
      if (!txRes.success) throw new Error('Could not retrieve transaction');
      const additions: Array<{parent_coin_info:string;puzzle_hash:string;amount:number}> =
        txRes.transaction?.additions ?? [];
      const amtTarget = Number(entry.amountMojo);
      const match = additions.find(a => a.amount === amtTarget)
        ?? additions.reduce((best, a) => Math.abs(a.amount - amtTarget) < Math.abs((best?.amount ?? Infinity) - amtTarget) ? a : best, additions[0]);
      if (!match) throw new Error('Could not find clawback coin in transaction');
      const coinId = await calculateCoinId(match.parent_coin_info, match.puzzle_hash, match.amount);
      const res = await walletRpc('spend_clawback_coins', { coin_ids: [`0x${coinId}`], fee: 0, is_clawback: true });
      if (res.success) {
        const next = loadClawbacks().filter(e => e.txId !== entry.txId);
        saveClawbacks(next);
        setClawbacks(next.filter(e => Date.now() < e.expiresAt));
        setCancelMsg(m => ({ ...m, [entry.txId]: 'Recalled successfully' }));
      } else {
        setCancelMsg(m => ({ ...m, [entry.txId]: res.error || 'Recall failed' }));
      }
    } catch (e: any) {
      setCancelMsg(m => ({ ...m, [entry.txId]: e.message }));
    } finally {
      setCancellingId(null);
    }
  }

  useEffect(() => {
    setEvents([]); setError(''); setLoading(true);

    (async () => {
      try {
        const puzzleHashes = wallet.addresses.map(a => a.puzzleHashHex);
        const all: HistoryEvent[] = [];

        // ── XCH history ──────────────────────────────────────────────────────
        const xchRecords = await getCoinRecords(nodeUrl, puzzleHashes, true);

        // Compute coin IDs for all records (for change-output detection)
        const xchIdMap = new Map<CoinRecord, string>();
        await mapConcurrent(xchRecords, 20, async r => {
          xchIdMap.set(r, await calculateCoinId(r.coin.parent_coin_info, r.coin.puzzle_hash, r.coin.amount));
        });
        const ownXchIds = new Set(xchIdMap.values());

        // Received: external coins (parent not ours)
        for (const r of xchRecords) {
          const parentId = (r.coin.parent_coin_info || '').replace('0x', '').toLowerCase();
          if (!ownXchIds.has(parentId)) {
            all.push({ type: 'received', amount: BigInt(r.coin.amount),
              ticker: 'XCH', label: 'Chia', assetId: null, isCat: false,
              timestamp: r.timestamp, blockIndex: r.confirmed_block_index,
              txId: xchIdMap.get(r)! });
          }
        }

        // Sent: group spent coins by spent_block_index, net of change
        const xchSpentByBlock = new Map<number, CoinRecord[]>();
        for (const r of xchRecords) {
          if (r.spent) {
            const arr = xchSpentByBlock.get(r.spent_block_index) ?? [];
            arr.push(r);
            xchSpentByBlock.set(r.spent_block_index, arr);
          }
        }
        for (const [blockIndex, spent] of xchSpentByBlock) {
          const spentIds = new Set(spent.map(r => xchIdMap.get(r)!));
          const totalSpent = spent.reduce((s, r) => s + BigInt(r.coin.amount), 0n);
          const changeInBlock = xchRecords.filter(r => {
            const parentId = (r.coin.parent_coin_info || '').replace('0x', '').toLowerCase();
            return r.confirmed_block_index === blockIndex && spentIds.has(parentId);
          });
          const netSent = totalSpent - changeInBlock.reduce((s, r) => s + BigInt(r.coin.amount), 0n);
          if (netSent <= 0n) continue;
          const ts = changeInBlock[0]?.timestamp ?? spent[0].timestamp;
          all.push({ type: 'sent', amount: netSent,
            ticker: 'XCH', label: 'Chia', assetId: null, isCat: false,
            timestamp: ts, blockIndex, txId: `xch-${blockIndex}` });
        }

        // ── CAT history ───────────────────────────────────────────────────────
        if (catBalances.length > 0) {
          // Build outer puzzle hash → asset lookup from already-discovered coins
          const phToAsset = new Map<string, { assetId: string; ticker: string; name: string }>();
          for (const bal of catBalances) {
            for (const coin of bal.coins) {
              phToAsset.set((coin.puzzleHash || '').replace('0x', '').toLowerCase(),
                { assetId: bal.assetId, ticker: bal.ticker, name: bal.name });
            }
          }

          // Fetch all hint-found CAT coins including spent
          const hintResults = await getCatCoinsByHint(nodeUrl, puzzleHashes, true);

          // Annotate each coin with asset info; fall back to phAssetCache for fully-spent tokens
          type AnnotatedCat = { cr: any; asset: { assetId: string; ticker: string; name: string } };
          const annotated: AnnotatedCat[] = [];
          const unknownPhs = new Set<string>();
          for (const { coins } of hintResults) {
            for (const cr of coins) {
              const ph = (cr.coin.puzzle_hash || '').replace('0x', '').toLowerCase();
              const asset = phToAsset.get(ph);
              if (asset) { annotated.push({ cr, asset }); continue; }
              // Try phAssetCache for tokens no longer in catBalances (fully spent)
              const assetId = resolveOuterPuzzleHash(ph);
              if (assetId) { unknownPhs.add(`${ph}:${assetId}`); annotated.push({ cr, asset: { assetId, ticker: assetId.slice(0,4).toUpperCase(), name: `CAT ${assetId.slice(0,8)}` } }); }
            }
          }
          // Resolve names for the fallback assets asynchronously
          if (unknownPhs.size > 0) {
            await Promise.allSettled([...unknownPhs].map(async key => {
              const [, assetId] = key.split(':');
              const meta = await getTokenMetadata(assetId);
              for (const item of annotated) {
                if (item.asset.assetId === assetId && item.asset.name.startsWith('CAT ')) {
                  item.asset.ticker = meta.ticker;
                  item.asset.name = meta.name;
                }
              }
            }));
          }

          // Compute CAT coin IDs
          const catIdMap = new Map<any, string>();
          await mapConcurrent(annotated, 20, async ({ cr }) => {
            catIdMap.set(cr, await calculateCoinId(cr.coin.parent_coin_info, cr.coin.puzzle_hash, cr.coin.amount));
          });
          const ownCatIds = new Set(catIdMap.values());

          // Received CAT: external parent
          for (const { cr, asset } of annotated) {
            const parentId = (cr.coin.parent_coin_info || '').replace('0x', '').toLowerCase();
            if (!ownCatIds.has(parentId)) {
              all.push({ type: 'received', amount: BigInt(cr.coin.amount),
                ticker: asset.ticker, label: asset.name,
                assetId: asset.assetId, isCat: true,
                timestamp: cr.timestamp, blockIndex: cr.confirmed_block_index,
                txId: catIdMap.get(cr)! });
            }
          }

          // Sent CAT: group spent coins by (assetId, spent_block_index)
          const catSpentByKey = new Map<string, AnnotatedCat[]>();
          for (const item of annotated) {
            if (!item.cr.spent) continue;
            const key = `${item.asset.assetId}:${item.cr.spent_block_index}`;
            const arr = catSpentByKey.get(key) ?? [];
            arr.push(item);
            catSpentByKey.set(key, arr);
          }
          for (const [, group] of catSpentByKey) {
            const { asset } = group[0];
            const blockIndex = group[0].cr.spent_block_index;
            const spentIds = new Set(group.map(({ cr }) => catIdMap.get(cr)!));
            const totalSpent = group.reduce((s, { cr }) => s + BigInt(cr.coin.amount), 0n);
            const changeInBlock = annotated.filter(({ cr, asset: a }) => {
              const parentId = (cr.coin.parent_coin_info || '').replace('0x', '').toLowerCase();
              return a.assetId === asset.assetId
                && cr.confirmed_block_index === blockIndex
                && spentIds.has(parentId);
            });
            const netSent = totalSpent - changeInBlock.reduce((s, { cr }) => s + BigInt(cr.coin.amount), 0n);
            if (netSent <= 0n) continue;
            const ts = changeInBlock[0]?.cr.timestamp ?? group[0].cr.timestamp;
            all.push({ type: 'sent', amount: netSent,
              ticker: asset.ticker, label: asset.name,
              assetId: asset.assetId, isCat: true,
              timestamp: ts, blockIndex, txId: `cat-${asset.assetId.slice(0, 8)}-${blockIndex}` });
          }
        }

        all.sort((a, b) => b.blockIndex - a.blockIndex || b.timestamp - a.timestamp);
        setEvents(all);

        // Prune pending txs that have now confirmed (matched in history)
        const confirmedIds = new Set(all.map(e => e.txId));
        const freshPending = loadPendingTxs().filter(t =>
          Date.now() < t.expiresAt && (t.txId ? !confirmedIds.has(t.txId) : true)
        );
        savePendingTxs(freshPending);
        setPendingTxs(freshPending);
      } catch (e: any) {
        setError(e.message);
      }
    })().finally(() => setLoading(false));
  }, [wallet.mnemonic, nodeUrl]); // re-run on wallet switch or node change

  const visible = events.slice(0, showCount);

  return (
    <div className="wallet-screen">
      <div className="section-label">Transaction History</div>
      {loading && <div className="balance-loading"><div className="spinner"/>Scanning chain…</div>}
      {!loading && error && <div className="error-msg">{error}</div>}
      {!loading && !error && events.length === 0 && (
        <div className="empty-state">
          <div style={{fontSize:36,marginBottom:12}}>🧾</div>
          No transactions found.
        </div>
      )}
      {/* Pending (mempool) transaction rows */}
      {pendingTxs.map(pt => (
        <div key={pt.id} style={{background:'rgba(90,160,255,0.06)',border:'1px solid rgba(90,160,255,0.35)',
          borderRadius:'var(--radius)',padding:'12px 14px',display:'flex',alignItems:'center',gap:12}}>
          <div style={{width:28,height:28,borderRadius:'50%',background:'rgba(90,160,255,0.15)',
            display:'flex',alignItems:'center',justifyContent:'center',fontSize:13,color:'var(--accent)'}}>
            ↑
          </div>
          <div style={{flex:1}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <span style={{fontSize:12,fontWeight:700,color:'var(--accent)'}}>Pending</span>
              <span style={{fontSize:12,color:'var(--text-primary)'}}>−{pt.amount} {pt.ticker}</span>
            </div>
            <div style={{fontSize:10,color:'var(--text-secondary)',marginTop:2}}>
              Submitted · awaiting confirmation
            </div>
          </div>
          <div style={{width:14,height:14,border:'2px solid var(--accent)',borderTopColor:'transparent',
            borderRadius:'50%',animation:'spin 0.8s linear infinite',flexShrink:0}}/>
        </div>
      ))}

      {/* Pending clawback rows */}
      {clawbacks.map(entry => {
        const remaining = Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
        const label = remaining >= 3600
          ? `${Math.floor(remaining / 3600)}h ${Math.floor((remaining % 3600) / 60)}m`
          : remaining >= 60 ? `${Math.floor(remaining / 60)}m ${remaining % 60}s` : `${remaining}s`;
        const msg = cancelMsg[entry.txId];
        return (
          <div key={entry.txId} style={{background:'rgba(224,123,58,0.07)',border:'1px solid rgba(224,123,58,0.4)',
            borderRadius:'var(--radius)',padding:'12px 14px',display:'flex',flexDirection:'column',gap:6}}>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
              <div>
                <span style={{fontSize:12,fontWeight:700,color:'var(--warn)'}}>⏳ Clawback pending</span>
                <span style={{fontSize:12,color:'var(--text-primary)',marginLeft:8}}>
                  −{formatMojoToXch(BigInt(entry.amountMojo))} XCH
                </span>
              </div>
              <span style={{fontSize:10,color:'var(--warn)',fontFamily:'var(--font-mono)'}}>{label} left</span>
            </div>
            <div style={{fontSize:10,color:'var(--text-secondary)',fontFamily:'var(--font-mono)',
              overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
              → {entry.toAddress}
            </div>
            {msg ? (
              <div style={{fontSize:11,color: msg.includes('success') ? 'var(--accent)' : '#ff6b6b'}}>{msg}</div>
            ) : (
              <button onClick={() => handleCancelClawback(entry)}
                disabled={cancellingId === entry.txId}
                style={{alignSelf:'flex-start',padding:'6px 12px',fontSize:11,fontWeight:600,cursor:'pointer',
                  background:'none',border:'1px solid var(--warn)',borderRadius:'var(--radius-sm)',
                  color:'var(--warn)',transition:'all 0.15s'}}>
                {cancellingId === entry.txId ? 'Recalling…' : 'Recall'}
              </button>
            )}
          </div>
        );
      })}

      {visible.map(ev => {
        const amountStr = ev.isCat ? formatCatAmount(ev.amount) : formatMojoToXch(ev.amount);
        const date = new Date(ev.timestamp * 1000);
        const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        const expanded = expandedTxId === ev.txId;
        return (
          <div key={ev.txId}>
            <div className="tx-row" style={{cursor:'pointer'}}
              onClick={() => setExpandedTxId(expanded ? null : ev.txId)}>
              <div className={`tx-icon ${ev.type === 'sent' ? 'tx-send' : 'tx-recv'}`}>
                {ev.type === 'sent' ? '↑' : '↓'}
              </div>
              <div className="tx-info">
                <div className="tx-top">
                  <span className="tx-type">{ev.type === 'sent' ? 'Sent' : 'Received'}</span>
                  <span className={`tx-amount ${ev.type === 'sent' ? 'tx-amount-send' : 'tx-amount-recv'}`}>
                    {ev.type === 'sent' ? '−' : '+'}{amountStr} {ev.ticker}
                  </span>
                </div>
                <div className="tx-bottom">
                  <span className="tx-date">{dateStr} · {timeStr}</span>
                  <span style={{fontSize:10,color:'var(--text-dim)',marginLeft:6}}>{expanded ? '▲' : '▼'}</span>
                </div>
              </div>
            </div>
            {expanded && (
              <div style={{margin:'0 0 4px 0',background:'var(--bg-card)',border:'1px solid var(--border)',
                borderRadius:'0 0 var(--radius) var(--radius)',padding:'10px 14px',
                display:'flex',flexDirection:'column',gap:6}}>
                <div style={{display:'flex',justifyContent:'space-between',fontSize:11}}>
                  <span style={{color:'var(--text-secondary)'}}>Block</span>
                  <span style={{color:'var(--text-primary)',fontFamily:'var(--font-mono)'}}>#{ev.blockIndex.toLocaleString()}</span>
                </div>
                <div style={{display:'flex',justifyContent:'space-between',fontSize:11}}>
                  <span style={{color:'var(--text-secondary)'}}>Amount (mojo)</span>
                  <span style={{color:'var(--text-primary)',fontFamily:'var(--font-mono)'}}>{ev.amount.toLocaleString()}</span>
                </div>
                {ev.assetId && (
                  <div style={{display:'flex',justifyContent:'space-between',fontSize:11}}>
                    <span style={{color:'var(--text-secondary)'}}>Asset ID</span>
                    <span style={{color:'var(--text-dim)',fontFamily:'var(--font-mono)',fontSize:9}}>
                      {ev.assetId.slice(0,16)}…
                    </span>
                  </div>
                )}
                <div style={{display:'flex',justifyContent:'space-between',fontSize:11,alignItems:'center'}}>
                  <span style={{color:'var(--text-secondary)'}}>Coin ID</span>
                  <span style={{color:'var(--text-dim)',fontFamily:'var(--font-mono)',fontSize:9}}>
                    {ev.txId.length > 20 ? `${ev.txId.slice(0,14)}…` : ev.txId}
                  </span>
                </div>
                <a href={`https://www.spacescan.io/block/${ev.blockIndex}`} target="_blank" rel="noopener noreferrer"
                  style={{fontSize:11,color:'var(--accent)',textDecoration:'none',marginTop:2}}>
                  ↗ View block on Spacescan
                </a>
              </div>
            )}
          </div>
        );
      })}
      {events.length > showCount && (
        <button className="btn btn-secondary" style={{marginTop:8}}
          onClick={() => setShowCount(n => n + 50)}>
          Load more ({events.length - showCount} remaining)
        </button>
      )}
    </div>
  );
}

function OffersScreen({ catBalances }: { catBalances: CatBalance[] }) {
  const [tab, setTab] = useState<'take'|'create'>('take');

  // ── Take offer state ──
  const [offerStr, setOfferStr] = useState('');
  const [summary, setSummary] = useState<any>(null);
  const [summaryError, setSummaryError] = useState('');
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [fee, setFee] = useState('0.00005');
  const [status, setStatus] = useState<'idle'|'submitting'|'success'|'error'>('idle');
  const [resultMsg, setResultMsg] = useState('');
  const [summaryMeta, setSummaryMeta] = useState<Record<string, {name:string;ticker:string}>>({});

  // ── Create offer state ──
  const [giveType, setGiveType] = useState<'xch'|'cat'>('xch');
  const [giveAssetId, setGiveAssetId] = useState('');
  const [giveAmount, setGiveAmount] = useState('');
  const [wantType, setWantType] = useState<'xch'|'cat'>('cat');
  const [wantAssetId, setWantAssetId] = useState('');
  const [wantAmount, setWantAmount] = useState('');
  const [createFee, setCreateFee] = useState('0');
  const [creating, setCreating] = useState(false);
  const [createdOffer, setCreatedOffer] = useState('');
  const [createError, setCreateError] = useState('');
  const [offerCopied, setOfferCopied] = useState(false);

  const knownAssets = React.useMemo(() => {
    const m: Record<string, {name:string;ticker:string}> = {};
    for (const b of catBalances) m[b.assetId.toLowerCase()] = { name: b.name, ticker: b.ticker };
    return m;
  }, [catBalances]);

  function isXchKey(key: string) {
    return key === '1' || key.toLowerCase() === 'xch' || key === '0' || key.toLowerCase() === '0000000000000000000000000000000000000000000000000000000000000000';
  }

  function describeAsset(key: string, amt: number | bigint): string {
    const amount = BigInt(amt);
    if (isXchKey(key)) return `${formatMojoToXch(amount)} XCH`;
    const lkey = key.toLowerCase();
    const known = knownAssets[lkey] || summaryMeta[lkey];
    const ticker = known?.ticker ?? lkey.slice(0, 6).toUpperCase();
    return `${formatCatAmount(amount)} ${ticker}`;
  }

  async function handleDecode() {
    const str = offerStr.trim();
    if (!str.startsWith('offer1')) { setSummaryError('Invalid offer — must start with "offer1"'); return; }
    setLoadingSummary(true); setSummaryError(''); setSummary(null);
    try {
      const res = await walletRpc('get_offer_summary', { offer: str });
      if (!res.success) throw new Error(res.error || 'Failed to decode offer');
      setSummary(res.summary);
      const meta: Record<string, {name:string;ticker:string}> = {};
      const infos = res.summary?.infos ?? {};
      for (const key of [...Object.keys(res.summary?.offered ?? {}), ...Object.keys(res.summary?.requested ?? {})]) {
        if (!isXchKey(key) && /^[0-9a-f]{64}$/i.test(key) && !knownAssets[key.toLowerCase()]) {
          const info = infos[key];
          if (info?.also_known_as) {
            meta[key.toLowerCase()] = { name: info.also_known_as, ticker: info.also_known_as.slice(0, 6).toUpperCase() };
          } else {
            const m = await getTokenMetadata(key.toLowerCase());
            meta[key.toLowerCase()] = { name: m.name, ticker: m.ticker };
          }
        }
      }
      setSummaryMeta(meta);
    } catch (e: any) { setSummaryError(e.message); }
    finally { setLoadingSummary(false); }
  }

  async function handleTake() {
    if (!summary || status === 'submitting') return;
    setStatus('submitting'); setResultMsg('');
    const feeF = parseFloat(fee || '0');
    const feeMojo = BigInt(isNaN(feeF) ? 0 : Math.round(feeF * 1_000_000_000_000));
    try {
      const res = await walletRpc('take_offer', { offer: offerStr.trim(), fee: feeMojo });
      if (res.success) { setStatus('success'); setResultMsg('Offer accepted! Transaction submitted to the network.'); }
      else { setStatus('error'); setResultMsg(res.error || 'Failed to accept offer'); }
    } catch (e: any) { setStatus('error'); setResultMsg(e.message); }
  }

  async function handleCreate() {
    const giveAmtF = parseFloat(giveAmount || '0');
    const wantAmtF = parseFloat(wantAmount || '0');
    const createFeeF = parseFloat(createFee || '0');
    if (isNaN(giveAmtF) || giveAmtF <= 0 || isNaN(wantAmtF) || wantAmtF <= 0) {
      setCreateError('Enter amounts for both sides'); return;
    }
    if (giveType === 'cat' && !giveAssetId.trim()) { setCreateError('Select a token to give'); return; }
    if (wantType === 'cat' && !wantAssetId.trim()) { setCreateError('Enter asset ID to request'); return; }
    if (giveType === wantType && giveType === 'xch') { setCreateError('Cannot offer XCH for XCH'); return; }
    if (giveType === wantType && giveType === 'cat' && giveAssetId.toLowerCase() === wantAssetId.toLowerCase()) {
      setCreateError('Cannot offer same token for itself'); return;
    }

    setCreating(true); setCreateError(''); setCreatedOffer('');
    try {
      const giveMojo = giveType === 'xch'
        ? BigInt(Math.round(giveAmtF * 1_000_000_000_000))
        : BigInt(Math.round(giveAmtF * 1000));
      const wantMojo = wantType === 'xch'
        ? BigInt(Math.round(wantAmtF * 1_000_000_000_000))
        : BigInt(Math.round(wantAmtF * 1000));
      const feeMojo = BigInt(Math.round(createFeeF * 1_000_000_000_000));

      const offerDict: Record<string, bigint> = {};
      // Give side (negative = offering)
      if (giveType === 'xch') offerDict['1'] = -giveMojo;
      else offerDict[giveAssetId.toLowerCase()] = -giveMojo;
      // Want side (positive = requesting)
      if (wantType === 'xch') {
        const cur = offerDict['1'] ?? 0n;
        offerDict['1'] = cur + wantMojo;
      } else {
        const key = wantAssetId.toLowerCase();
        const cur = offerDict[key] ?? 0n;
        offerDict[key] = cur + wantMojo;
      }

      const res = await walletRpc('create_offer_for_ids', {
        offer: offerDict, fee: feeMojo, validate_only: false,
      });
      if (res.success && res.offer) { setCreatedOffer(res.offer); }
      else throw new Error(res.error || 'Failed to create offer');
    } catch (e: any) { setCreateError(e.message); }
    finally { setCreating(false); }
  }

  function handleCopyOffer() {
    navigator.clipboard.writeText(createdOffer);
    setOfferCopied(true); setTimeout(() => setOfferCopied(false), 2000);
  }

  const offered = Object.entries(summary?.offered ?? {});
  const requested = Object.entries(summary?.requested ?? {});

  const tabStyle = (active: boolean) => ({
    flex: 1, padding: '9px 0', fontSize: 13, fontWeight: 600,
    background: active ? 'var(--accent)' : 'var(--bg-card)',
    color: active ? '#0a0b0f' : 'var(--text-secondary)',
    border: '1px solid var(--border)', cursor: 'pointer', transition: 'all 0.15s',
  });

  return (
    <div className="wallet-screen">
      <div className="section-label">Offers</div>

      {/* Tab switcher */}
      <div style={{display:'flex',gap:0,borderRadius:'var(--radius)',overflow:'hidden',marginBottom:16}}>
        <button style={{...tabStyle(tab==='take'),borderRadius:'var(--radius) 0 0 var(--radius)'}}
          onClick={() => setTab('take')}>Take Offer</button>
        <button style={{...tabStyle(tab==='create'),borderRadius:'0 var(--radius) var(--radius) 0',borderLeft:'none'}}
          onClick={() => setTab('create')}>Create Offer</button>
      </div>

      {/* ── Create Offer ── */}
      {tab === 'create' && (
        <div style={{display:'flex',flexDirection:'column',gap:12}}>
          <div style={{fontSize:12,color:'var(--text-secondary)',lineHeight:1.6}}>
            Build an offer and share the string with your trade partner or post it on Dexie.
          </div>

          {/* Give side */}
          <div style={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius)',padding:'14px 16px',display:'flex',flexDirection:'column',gap:10}}>
            <div style={{fontSize:11,color:'var(--text-secondary)',letterSpacing:'0.08em'}}>YOU GIVE</div>
            <div style={{display:'flex',gap:8}}>
              <button onClick={() => setGiveType('xch')} style={{
                flex:1,padding:'8px',fontSize:12,fontWeight:600,cursor:'pointer',borderRadius:'var(--radius-sm)',border:'1px solid var(--border)',
                background: giveType==='xch' ? 'var(--accent)' : 'var(--bg-input)', color: giveType==='xch' ? '#0a0b0f' : 'var(--text-secondary)',
              }}>XCH</button>
              <button onClick={() => setGiveType('cat')} style={{
                flex:1,padding:'8px',fontSize:12,fontWeight:600,cursor:'pointer',borderRadius:'var(--radius-sm)',border:'1px solid var(--border)',
                background: giveType==='cat' ? 'var(--accent)' : 'var(--bg-input)', color: giveType==='cat' ? '#0a0b0f' : 'var(--text-secondary)',
              }}>Token (CAT)</button>
            </div>
            {giveType === 'cat' && (
              <select value={giveAssetId} onChange={e => setGiveAssetId(e.target.value)}
                style={{background:'var(--bg-input)',border:'1px solid var(--border)',color:'var(--text-primary)',
                  borderRadius:'var(--radius-sm)',padding:'9px 10px',fontSize:12,width:'100%'}}>
                <option value="">— Pick token —</option>
                {catBalances.map(b => (
                  <option key={b.assetId} value={b.assetId}>{b.ticker} — {b.name}</option>
                ))}
              </select>
            )}
            <input className="address-input" type="number" min="0" step="0.001"
              placeholder={giveType === 'xch' ? '0.00 (XCH)' : '0.000 (tokens)'}
              value={giveAmount} onChange={e => setGiveAmount(e.target.value)}
              style={{width:'100%',boxSizing:'border-box',padding:'10px 12px',fontSize:14}}/>
          </div>

          {/* Want side */}
          <div style={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius)',padding:'14px 16px',display:'flex',flexDirection:'column',gap:10}}>
            <div style={{fontSize:11,color:'var(--text-secondary)',letterSpacing:'0.08em'}}>YOU WANT</div>
            <div style={{display:'flex',gap:8}}>
              <button onClick={() => setWantType('xch')} style={{
                flex:1,padding:'8px',fontSize:12,fontWeight:600,cursor:'pointer',borderRadius:'var(--radius-sm)',border:'1px solid var(--border)',
                background: wantType==='xch' ? 'var(--accent)' : 'var(--bg-input)', color: wantType==='xch' ? '#0a0b0f' : 'var(--text-secondary)',
              }}>XCH</button>
              <button onClick={() => setWantType('cat')} style={{
                flex:1,padding:'8px',fontSize:12,fontWeight:600,cursor:'pointer',borderRadius:'var(--radius-sm)',border:'1px solid var(--border)',
                background: wantType==='cat' ? 'var(--accent)' : 'var(--bg-input)', color: wantType==='cat' ? '#0a0b0f' : 'var(--text-secondary)',
              }}>Token (CAT)</button>
            </div>
            {wantType === 'cat' && (
              <>
                <select value={wantAssetId} onChange={e => setWantAssetId(e.target.value)}
                  style={{background:'var(--bg-input)',border:'1px solid var(--border)',color:'var(--text-primary)',
                    borderRadius:'var(--radius-sm)',padding:'9px 10px',fontSize:12,width:'100%'}}>
                  <option value="">— Pick known token —</option>
                  {catBalances.map(b => (
                    <option key={b.assetId} value={b.assetId}>{b.ticker} — {b.name}</option>
                  ))}
                </select>
                <input className="address-input" type="text" placeholder="or paste 64-char asset ID"
                  value={wantAssetId} onChange={e => setWantAssetId(e.target.value.trim().toLowerCase())}
                  style={{width:'100%',boxSizing:'border-box',padding:'10px 12px',fontSize:11,fontFamily:'var(--font-mono)'}}
                  spellCheck={false}/>
              </>
            )}
            <input className="address-input" type="number" min="0" step="0.001"
              placeholder={wantType === 'xch' ? '0.00 (XCH)' : '0.000 (tokens)'}
              value={wantAmount} onChange={e => setWantAmount(e.target.value)}
              style={{width:'100%',boxSizing:'border-box',padding:'10px 12px',fontSize:14}}/>
          </div>

          <div>
            <div style={{fontSize:11,color:'var(--text-secondary)',letterSpacing:'0.08em',marginBottom:6}}>FEE (XCH)</div>
            <input className="address-input" type="number" min="0" step="0.00001"
              value={createFee} onChange={e => setCreateFee(e.target.value)}
              style={{width:'100%',boxSizing:'border-box',padding:'10px 12px',fontSize:14}}/>
          </div>

          {createError && <div className="error-msg">{createError}</div>}

          {!createdOffer ? (
            <button onClick={handleCreate} disabled={creating} style={{
              padding:'14px',fontWeight:700,fontSize:15,
              background: creating ? 'var(--bg-card)' : 'var(--accent)',
              color: creating ? 'var(--text-dim)' : '#0a0b0f',
              border:'1px solid var(--border)',borderRadius:'var(--radius)',
              cursor: creating ? 'not-allowed' : 'pointer',transition:'all 0.2s',
            }}>
              {creating ? '⏳ Creating…' : 'Create Offer'}
            </button>
          ) : (
            <div style={{display:'flex',flexDirection:'column',gap:10}}>
              <div style={{fontSize:11,color:'var(--text-secondary)',letterSpacing:'0.08em'}}>OFFER STRING — SHARE THIS</div>
              <textarea rows={5} readOnly value={createdOffer}
                style={{width:'100%',background:'var(--bg-input)',border:'1px solid var(--accent)',
                  borderRadius:'var(--radius-sm)',color:'var(--text-secondary)',fontSize:9,
                  fontFamily:'var(--font-mono)',padding:'10px 12px',resize:'none',lineHeight:1.5}}/>
              <div style={{display:'flex',gap:8}}>
                <button className={`btn ${offerCopied ? 'btn-primary' : 'btn-secondary'}`} style={{flex:1}}
                  onClick={handleCopyOffer}>
                  {offerCopied ? '✓ Copied!' : 'Copy Offer String'}
                </button>
                <button className="btn btn-secondary" style={{flex:1}}
                  onClick={() => { setCreatedOffer(''); setGiveAmount(''); setWantAmount(''); setCreateError(''); }}>
                  New Offer
                </button>
              </div>
              <div style={{fontSize:11,color:'var(--text-dim)',lineHeight:1.6}}>
                Share this string with your trade partner or post it on{' '}
                <a href="https://dexie.space" target="_blank" rel="noopener noreferrer"
                  style={{color:'var(--accent)'}}>dexie.space</a>.
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Take Offer ── */}
      {tab === 'take' && (
      <div style={{display:'flex',flexDirection:'column',gap:12}}>
        <div>
          <div style={{fontSize:11,color:'var(--text-secondary)',letterSpacing:'0.08em',marginBottom:6}}>OFFER STRING</div>
          <textarea rows={4} placeholder="offer1…" value={offerStr}
            onChange={e => { setOfferStr(e.target.value.trim()); setSummary(null); setSummaryError(''); setStatus('idle'); setResultMsg(''); }}
            style={{width:'100%',background:'var(--bg-input)',border:'1px solid var(--border)',
              borderRadius:'var(--radius-sm)',color:'var(--text-primary)',fontSize:10,
              fontFamily:'var(--font-mono)',padding:'10px 12px',resize:'vertical',lineHeight:1.5}}
            spellCheck={false}
          />
        </div>

        {summaryError && <div className="error-msg">{summaryError}</div>}

        {!summary && status !== 'success' && (
          <button className="btn btn-secondary" onClick={handleDecode}
            disabled={!offerStr.trim() || loadingSummary}>
            {loadingSummary ? <><div className="spinner" style={{display:'inline-block',marginRight:6}}/>Decoding…</> : 'Decode Offer'}
          </button>
        )}

        {summary && status !== 'success' && (
          <>
            <div style={{background:'var(--bg-card)',border:'1px solid var(--border)',
              borderRadius:'var(--radius)',padding:'16px',display:'flex',flexDirection:'column',gap:12}}>
              <div>
                <div style={{fontSize:11,color:'var(--text-secondary)',letterSpacing:'0.08em',marginBottom:6}}>YOU GIVE</div>
                {requested.map(([key, amt]) => (
                  <div key={key} style={{fontSize:18,fontWeight:700,color:'var(--error)'}}>
                    −{describeAsset(key, amt as any)}
                  </div>
                ))}
                {requested.length === 0 && <div style={{fontSize:13,color:'var(--text-dim)'}}>Nothing (maker gifts)</div>}
              </div>
              <div style={{borderTop:'1px solid var(--border)',paddingTop:12}}>
                <div style={{fontSize:11,color:'var(--text-secondary)',letterSpacing:'0.08em',marginBottom:6}}>YOU RECEIVE</div>
                {offered.map(([key, amt]) => (
                  <div key={key} style={{fontSize:18,fontWeight:700,color:'var(--accent)'}}>
                    +{describeAsset(key, amt as any)}
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div style={{fontSize:11,color:'var(--text-secondary)',letterSpacing:'0.08em',marginBottom:6}}>FEE (XCH)</div>
              <input className="address-input" type="number" min="0" step="0.00001"
                value={fee} onChange={e => setFee(e.target.value)}
                style={{width:'100%',boxSizing:'border-box',padding:'10px 12px',fontSize:14}}/>
            </div>

            {status === 'error' && (
              <div style={{padding:'10px 12px',background:'rgba(220,50,50,0.1)',
                border:'1px solid #dc3232',borderRadius:8,fontSize:12,color:'#ff6b6b'}}>
                ✗ {resultMsg}
              </div>
            )}

            <button onClick={handleTake} disabled={status === 'submitting'} style={{
              padding:'14px',fontWeight:700,fontSize:15,
              background: status === 'submitting' ? 'var(--bg-card)' : 'var(--accent)',
              color: status === 'submitting' ? 'var(--text-dim)' : '#0a0b0f',
              border:'1px solid var(--border)',borderRadius:'var(--radius)',
              cursor: status === 'submitting' ? 'not-allowed' : 'pointer',transition:'all 0.2s',
            }}>
              {status === 'submitting' ? '⏳ Submitting…' : 'Accept Offer'}
            </button>
          </>
        )}

        {status === 'success' && (
          <div style={{padding:'14px',background:'rgba(249,115,22,0.1)',
            border:'1px solid var(--accent)',borderRadius:12,fontSize:13,color:'var(--accent)'}}>
            ✓ {resultMsg}
          </div>
        )}
      </div>
      )}
    </div>
  );
}

function SendScreen({ wallet, onSendSuccess, addressBook, onTxConfirmed }: {
  wallet: WalletState;
  onSendSuccess: () => void;
  addressBook: AddressEntry[];
  onTxConfirmed?: (msg: string) => void;
}) {
  const [toAddress, setToAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [fee, setFee] = useState('0.00005');
  const [status, setStatus] = useState<'idle' | 'sending' | 'pending' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [balance, setBalance] = useState<bigint | null>(null);
  const [balanceError, setBalanceError] = useState('');
  const [showBook, setShowBook] = useState(false);
  const [useClawback, setUseClawback] = useState(false);
  const [clawbackTimelock, setClawbackTimelock] = useState(3600);
  const sendingRef = React.useRef(false);
  const pollTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const puzzleHashes = wallet.addresses.map(a => a.puzzleHashHex);
    getBalance(NODE_URL, puzzleHashes)
      .then(r => { setBalance(r.totalMojo); setBalanceError(''); })
      .catch(() => { setBalanceError('Cannot reach proxy server. Check your internet connection.'); });
  }, [status, wallet.addresses]);

  useEffect(() => {
    return () => { if (pollTimerRef.current) clearTimeout(pollTimerRef.current); };
  }, []);

  const totalMojo = balance ?? BigInt(0);
  const feeF = parseFloat(fee || '0');
  const amtF = parseFloat(amount || '0');
  const feeMojo = BigInt(isNaN(feeF) ? 0 : Math.round(feeF * 1_000_000_000_000));
  const amountMojo = BigInt(isNaN(amtF) ? 0 : Math.round(amtF * 1_000_000_000_000));
  const maxSend = totalMojo > feeMojo ? totalMojo - feeMojo : BigInt(0);

  const isValid = isValidXchAddress(toAddress) &&
    amountMojo > BigInt(0) &&
    amountMojo <= maxSend;

  function pollConfirmation(txId: string, attempts = 0) {
    if (attempts >= 24) {
      setStatus('success');
      setMessage(`Sent ${formatMojoToXch(amountMojo)} XCH`);
      onSendSuccess();
      return;
    }
    pollTimerRef.current = setTimeout(async () => {
      try {
        const res = await walletRpc('get_transaction', { transaction_id: txId });
        if (res.success && res.transaction?.confirmed) {
          const msg = `Sent ${formatMojoToXch(amountMojo)} XCH — confirmed at block #${res.transaction.confirmed_at_height?.toLocaleString()}`;
          setStatus('success');
          setMessage(msg);
          onSendSuccess();
          onTxConfirmed?.(msg);
          return;
        }
      } catch { /* keep polling */ }
      pollConfirmation(txId, attempts + 1);
    }, 5000);
  }

  async function handleSend() {
    if (!isValid || sendingRef.current) return;
    sendingRef.current = true;
    setStatus('sending');
    setMessage('');
    try {
      if (useClawback) {
        const res = await walletRpc('send_transaction', {
          wallet_id: 1,
          amount: amountMojo,
          fee: feeMojo,
          address: toAddress,
          puzzle_decorator_list: [{ decorator: 'CLAWBACK', clawback_timelock: clawbackTimelock }],
        });
        if (res.success) {
          const txId = res.transaction?.name ?? res.transaction_id ?? '';
          const entry: ClawbackEntry = {
            txId, amount, amountMojo: amountMojo.toString(), toAddress,
            timelock: clawbackTimelock,
            submittedAt: Date.now(), expiresAt: Date.now() + clawbackTimelock * 1000,
          };
          saveClawbacks([...loadClawbacks(), entry]);
          setToAddress(''); setAmount('');
          const label = clawbackTimelock >= 3600
            ? `${clawbackTimelock / 3600}h` : `${clawbackTimelock / 60}m`;
          setStatus('success');
          setMessage(`Sent ${formatMojoToXch(amountMojo)} XCH with ${label} clawback window`);
          onSendSuccess();
        } else {
          setStatus('error');
          setMessage(res.error || 'Clawback send failed');
        }
      } else {
        const res = await walletRpc('send_transaction', {
          wallet_id: 1,
          address: toAddress,
          amount: amountMojo,
          fee: feeMojo,
        });
        if (res.success) {
          const txId = res.transaction_id || res.transaction?.name || '';
          const pendingId = txId || crypto.randomUUID();
          addPendingTx({ id: pendingId, type: 'sent', amount: formatMojoToXch(amountMojo),
            amountMojo: amountMojo.toString(), ticker: 'XCH', isCat: false,
            submittedAt: Date.now(), expiresAt: Date.now() + 5 * 60 * 1000, txId: txId || undefined });
          setToAddress(''); setAmount('');
          if (txId) {
            setStatus('pending'); setMessage(txId); pollConfirmation(txId);
          } else {
            setStatus('success'); setMessage(`Sent ${formatMojoToXch(amountMojo)} XCH`); onSendSuccess();
          }
        } else {
          setStatus('error'); setMessage(res.error || 'Transaction failed');
        }
      }
    } catch (e: any) {
      setStatus('error');
      setMessage(e.message);
    } finally {
      sendingRef.current = false;
    }
  }

  const isBusy = status === 'sending' || status === 'pending';

  return (
    <div className="wallet-screen">
      <div className="section-label">Send XCH</div>

      {balanceError && (
        <div style={{background:'rgba(220,50,50,0.1)',border:'1px solid #dc3232',
          borderRadius:8,padding:'10px 14px',fontSize:12,color:'#ff6b6b',marginBottom:4}}>
          {balanceError}
        </div>
      )}

      <div className="balance-card" style={{marginBottom: 20}}>
        <div style={{fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4}}>AVAILABLE</div>
        <div style={{fontSize: 22, fontWeight: 700, color: 'var(--text-primary)'}}>
          {formatMojoToXch(maxSend)} <span style={{color: 'var(--accent)', fontSize: 14}}>XCH</span>
        </div>
      </div>

      <div style={{display: 'flex', flexDirection: 'column', gap: 12}}>
        <div>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
            <div style={{fontSize: 11, color: 'var(--text-secondary)', letterSpacing: '0.08em'}}>TO ADDRESS</div>
            {addressBook.length > 0 && (
              <button onClick={()=>setShowBook(b=>!b)}
                style={{background:'none',border:'none',color:'var(--accent)',fontSize:11,cursor:'pointer',padding:0}}>
                {showBook ? 'Hide book' : '📋 Address book'}
              </button>
            )}
          </div>
          <input
            className="address-input"
            style={{width: '100%', boxSizing: 'border-box', padding: '10px 12px', fontSize: 12, fontFamily: 'var(--font-mono)'}}
            placeholder="xch1…"
            value={toAddress}
            onChange={e => setToAddress(e.target.value.trim())}
            spellCheck={false}
          />
          {showBook && addressBook.length > 0 && (
            <div style={{marginTop:6,display:'flex',flexDirection:'column',gap:4}}>
              {addressBook.map(entry => (
                <button key={entry.id}
                  onClick={()=>{ setToAddress(entry.address); setShowBook(false); }}
                  style={{display:'flex',justifyContent:'space-between',alignItems:'center',
                    background:'var(--bg-input)',border:'1px solid var(--border)',
                    borderRadius:'var(--radius-sm)',padding:'8px 12px',cursor:'pointer',
                    textAlign:'left',gap:8}}>
                  <span style={{fontSize:12,fontWeight:600,color:'var(--text-primary)',flexShrink:0}}>
                    {entry.label}
                  </span>
                  <span style={{fontSize:10,color:'var(--text-dim)',fontFamily:'var(--font-mono)',
                    overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                    {entry.address.slice(0,10)}…{entry.address.slice(-6)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
          <div>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
              <div style={{fontSize: 11, color: 'var(--text-secondary)', letterSpacing: '0.08em'}}>AMOUNT (XCH)</div>
              {maxSend > BigInt(0) && (
                <button onClick={() => {
                  const whole = maxSend / BigInt(1_000_000_000_000);
                  const frac = maxSend % BigInt(1_000_000_000_000);
                  const fracStr = frac === BigInt(0) ? '' : '.' + frac.toString().padStart(12, '0').replace(/0+$/, '');
                  setAmount(`${whole}${fracStr}`);
                }} style={{background:'none',border:'none',color:'var(--accent)',fontSize:11,cursor:'pointer',padding:0}}>
                  Max
                </button>
              )}
            </div>
            <input
              className="address-input"
              style={{width: '100%', boxSizing: 'border-box', padding: '10px 12px', fontSize: 14}}
              placeholder="0.000"
              type="number"
              min="0"
              step="0.001"
              value={amount}
              onChange={e => setAmount(e.target.value)}
            />
          </div>
          <div>
            <div style={{fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6, letterSpacing: '0.08em'}}>FEE (XCH)</div>
            <input
              className="address-input"
              style={{width: '100%', boxSizing: 'border-box', padding: '10px 12px', fontSize: 14}}
              placeholder="0.00005"
              type="number"
              min="0"
              step="0.00001"
              value={fee}
              onChange={e => setFee(e.target.value)}
            />
          </div>
        </div>

        {amount && amountMojo > BigInt(0) && (
          <div style={{fontSize: 11, color: 'var(--text-secondary)', padding: '8px 12px', background: 'var(--bg-card)', borderRadius: 8, border: '1px solid var(--border)'}}>
            Total: {formatMojoToXch(amountMojo + feeMojo)} XCH ({(amountMojo + feeMojo).toLocaleString()} mojo)
          </div>
        )}

        {/* Clawback toggle */}
        <div style={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius)',padding:'12px 14px'}}>
          <label style={{display:'flex',alignItems:'center',justifyContent:'space-between',cursor:'pointer'}}>
            <div>
              <div style={{fontSize:13,fontWeight:600,color:'var(--text-primary)'}}>Clawback send</div>
              <div style={{fontSize:11,color:'var(--text-secondary)',marginTop:2}}>Recall within a time window if sent in error</div>
            </div>
            <button onClick={() => setUseClawback(v => !v)} style={{
              width:44,height:24,borderRadius:12,border:'none',cursor:'pointer',
              background: useClawback ? 'var(--accent)' : 'var(--border)',
              position:'relative',transition:'background 0.2s',flexShrink:0,
            }}>
              <div style={{position:'absolute',top:3,left:useClawback?23:3,width:18,height:18,
                borderRadius:'50%',background:'#fff',transition:'left 0.2s'}}/>
            </button>
          </label>
          {useClawback && (
            <div style={{marginTop:10,display:'flex',alignItems:'center',gap:10}}>
              <div style={{fontSize:11,color:'var(--text-secondary)',flexShrink:0}}>RECALL WINDOW</div>
              <select value={clawbackTimelock} onChange={e => setClawbackTimelock(Number(e.target.value))}
                style={{flex:1,background:'var(--bg-input)',border:'1px solid var(--border)',color:'var(--text-primary)',
                  borderRadius:'var(--radius-sm)',padding:'7px 10px',fontSize:12}}>
                <option value={600}>10 minutes</option>
                <option value={3600}>1 hour</option>
                <option value={86400}>24 hours</option>
              </select>
            </div>
          )}
        </div>

        <button
          onClick={handleSend}
          disabled={!isValid || isBusy}
          style={{
            marginTop: 4,
            padding: '14px',
            background: isValid && !isBusy ? 'var(--accent)' : 'var(--bg-card)',
            color: isValid && !isBusy ? '#0a0b0f' : 'var(--text-dim)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            fontWeight: 700,
            fontSize: 15,
            cursor: isValid && !isBusy ? 'pointer' : 'not-allowed',
            transition: 'all 0.2s',
          }}
        >
          {status === 'sending' ? '⏳ Sending…' : '➤ Send XCH'}
        </button>

        {status === 'pending' && (
          <div style={{padding: '12px', background: 'rgba(249,115,22,0.06)', border: '1px solid var(--accent)', borderRadius: 8, fontSize: 13, color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 10}}>
            <div className="spinner" style={{borderTopColor: 'var(--accent)'}}/>
            Pending confirmation…
          </div>
        )}
        {status === 'success' && (
          <div style={{padding: '12px', background: 'rgba(249,115,22,0.1)', border: '1px solid var(--accent)', borderRadius: 8, fontSize: 13, color: 'var(--accent)'}}>
            ✓ {message}
          </div>
        )}
        {status === 'error' && (
          <div style={{padding: '12px', background: 'rgba(220,50,50,0.1)', border: '1px solid #dc3232', borderRadius: 8, fontSize: 13, color: '#ff6b6b'}}>
            ✗ {message}
          </div>
        )}
      </div>
    </div>
  );
}

const CLAWBACK_KEY = 'chia_clawback_sends';
const PENDING_TXS_KEY = 'chia_pending_txs';

interface PendingTx {
  id: string;
  type: 'sent';
  amount: string;
  amountMojo: string;
  ticker: string;
  isCat: boolean;
  submittedAt: number;
  expiresAt: number;
  txId?: string;
}

function loadPendingTxs(): PendingTx[] {
  try { return JSON.parse(sessionStorage.getItem(PENDING_TXS_KEY) || '[]'); } catch { return []; }
}
function savePendingTxs(txs: PendingTx[]) {
  try { sessionStorage.setItem(PENDING_TXS_KEY, JSON.stringify(txs)); } catch {}
}
function addPendingTx(tx: PendingTx) {
  savePendingTxs([...loadPendingTxs().filter(t => t.id !== tx.id), tx]);
}

interface ClawbackEntry {
  txId: string;
  amount: string;
  amountMojo: string;
  toAddress: string;
  timelock: number;
  submittedAt: number;
  expiresAt: number;
}

function loadClawbacks(): ClawbackEntry[] {
  try { return JSON.parse(sessionStorage.getItem(CLAWBACK_KEY) || '[]'); } catch { return []; }
}
function saveClawbacks(entries: ClawbackEntry[]) {
  try { sessionStorage.setItem(CLAWBACK_KEY, JSON.stringify(entries)); } catch {}
}

function NftsScreen({ wallet }: { wallet: WalletState }) {
  const address = wallet.addresses[0]?.address;

  useEffect(() => {
    window.location.href = address
      ? `/marketplace/profile?address=${encodeURIComponent(address)}`
      : '/marketplace/profile';
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="wallet-screen" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', padding: 40 }}>
      Opening NFT profile…
    </div>
  );
}

const WALLETS_KEY = 'chia_wallets';
const ACTIVE_WALLET_KEY = 'chia_active_wallet';
const LEGACY_STORAGE_KEY = 'chia_wallet_mnemonic';
// VAULT_SALT_KEY imported from ./lib/crypto

function LockScreen({ mode, walletList, onUnlock, onForgotPassword }: {
  mode: 'unlock' | 'migrate';
  walletList: WalletEntry[];
  onUnlock: (key: CryptoKey, updatedWallets?: WalletEntry[]) => void;
  onForgotPassword?: () => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  const handleUnlock = async () => {
    if (!password) { setError('Enter your password'); return; }
    setBusy(true);
    try {
      const saltB64 = localStorage.getItem(VAULT_SALT_KEY) || '';
      const key = await deriveKey(password, saltB64);
      const target = walletList.find(w => w.encryptedMnemonic);
      if (target) await decryptMnemonic(target.encryptedMnemonic!, key); // throws on wrong password
      onUnlock(key);
    } catch {
      setError('Incorrect password');
    } finally { setBusy(false); }
  };

  const handleMigrate = async () => {
    if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
    if (password !== confirm) { setError('Passwords do not match'); return; }
    setBusy(true);
    try {
      const saltB64 = generateAndStoreSalt();
      const key = await deriveKey(password, saltB64);
      const updated: WalletEntry[] = await Promise.all(
        walletList.map(async w => {
          if (w.mnemonic && !w.encryptedMnemonic) {
            const encryptedMnemonic = await encryptMnemonic(w.mnemonic, key);
            const { mnemonic: _m, ...rest } = w;
            return { ...rest, encryptedMnemonic };
          }
          return w;
        })
      );
      onUnlock(key, updated);
    } catch (e: any) {
      setError(e.message);
    } finally { setBusy(false); }
  };

  const isMigrate = mode === 'migrate';

  return (
    <div className="setup-screen">
      <div className="setup-hero">
        <div style={{fontSize:40,marginBottom:12}}>🔒</div>
        <h1>{isMigrate ? <><span className="accent">Secure</span> your wallet</> : <>Unlock <span className="accent">wallet</span></>}</h1>
        <p>{isMigrate
          ? 'Your seed phrase is currently stored unencrypted. Set a password to protect it.'
          : 'Enter your password to access your wallet.'
        }</p>
      </div>
      <div style={{display:'flex',flexDirection:'column',gap:12}}>
        <input
          type="password"
          placeholder={isMigrate ? 'New password (min 8 chars)' : 'Password'}
          value={password}
          onChange={e=>{setPassword(e.target.value);setError('');}}
          autoComplete={isMigrate ? 'new-password' : 'current-password'}
          onKeyDown={e=>{if(e.key==='Enter'&&!isMigrate)handleUnlock();}}
          style={{padding:'11px 14px',background:'var(--bg-input)',border:'1px solid var(--border)',
            borderRadius:'var(--radius)',color:'var(--text-primary)',fontSize:14,width:'100%',boxSizing:'border-box'}}
        />
        {isMigrate && (
          <input
            type="password"
            placeholder="Confirm password"
            value={confirm}
            onChange={e=>{setConfirm(e.target.value);setError('');}}
            autoComplete="new-password"
            style={{padding:'11px 14px',background:'var(--bg-input)',border:'1px solid var(--border)',
              borderRadius:'var(--radius)',color:'var(--text-primary)',fontSize:14,width:'100%',boxSizing:'border-box'}}
          />
        )}
      </div>
      {error && <div className="error-msg" style={{marginTop:8}}>{error}</div>}
      <button
        className="btn btn-primary"
        style={{marginTop:16}}
        disabled={busy || !password || (isMigrate && !confirm)}
        onClick={isMigrate ? handleMigrate : handleUnlock}
      >
        {busy ? (isMigrate ? 'Encrypting…' : 'Unlocking…') : (isMigrate ? 'Set password' : 'Unlock')}
      </button>
      {!isMigrate && onForgotPassword && (
        !showResetConfirm ? (
          <button
            onClick={() => setShowResetConfirm(true)}
            style={{background:'none',border:'none',color:'var(--text-secondary)',fontSize:12,
              cursor:'pointer',padding:'12px 0 0',textDecoration:'underline',textUnderlineOffset:3}}>
            Forgot password? Restore from seed phrase
          </button>
        ) : (
          <div style={{marginTop:12,background:'rgba(220,50,50,0.08)',border:'1px solid rgba(220,50,50,0.3)',
            borderRadius:'var(--radius)',padding:'12px 14px'}}>
            <div style={{fontSize:13,color:'var(--text-primary)',marginBottom:8,fontWeight:600}}>
              Wipe all wallets and restore?
            </div>
            <div style={{fontSize:12,color:'var(--text-secondary)',marginBottom:12,lineHeight:1.5}}>
              This will delete all stored wallets. You'll need to re-import your seed phrase.
            </div>
            <div style={{display:'flex',gap:8}}>
              <button className="btn btn-primary" style={{flex:1,background:'var(--error)',padding:'9px'}}
                onClick={onForgotPassword}>
                Wipe &amp; Restore
              </button>
              <button className="btn btn-secondary" style={{flex:1,padding:'9px'}}
                onClick={() => setShowResetConfirm(false)}>
                Cancel
              </button>
            </div>
          </div>
        )
      )}
    </div>
  );
}
const ADDRESS_BOOK_KEY = 'chia_address_book';
const HIDE_SMALL_KEY = 'chia_hide_small';
const IDLE_LOCK_KEY = 'chia_idle_lock';

export default function App() {
  const [wallet, setWallet] = useState<WalletState|null>(null);
  const [walletList, setWalletList] = useState<WalletEntry[]>([]);
  const [activeWalletId, setActiveWalletId] = useState<string|null>(null);
  const [screen, setScreen] = useState<Screen>('setup');
  const [sessionKey, setSessionKey] = useState<CryptoKey|null>(null);
  const [unlockMode, setUnlockMode] = useState<'unlock'|'migrate'|null>(null);
  const nodeUrl = NODE_URL;
  const [nodeStatus, setNodeStatus] = useState<NodeStatus|null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [addressBook, setAddressBook] = useState<AddressEntry[]>(() => {
    try { return JSON.parse(localStorage.getItem(ADDRESS_BOOK_KEY) || '[]'); }
    catch { return []; }
  });
  const [hideSmallBalances, setHideSmallBalances] = useState(() => localStorage.getItem(HIDE_SMALL_KEY) === '1');
  const [catBalances, setCatBalances] = useState<CatBalance[]>([]);
  const [idleLockMinutes, setIdleLockMinutes] = useState(() => {
    const saved = localStorage.getItem(IDLE_LOCK_KEY);
    return saved ? Number(saved) : 0;
  });
  const [showBackupBanner, setShowBackupBanner] = useState(() => {
    try { return localStorage.getItem('chia_backup_reminder') === 'pending'; } catch { return false; }
  });
  const [toast, setToast] = useState<string | null>(null);
  const lastActivityRef = React.useRef(Date.now());
  const toastTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = React.useCallback((msg: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(msg);
    toastTimerRef.current = setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(() => {
    try { localStorage.removeItem('chia_node_url'); } catch {}

    let wallets: WalletEntry[] = [];
    try { wallets = JSON.parse(localStorage.getItem(WALLETS_KEY) || '[]'); }
    catch { wallets = []; }

    // Migrate legacy single-mnemonic storage
    if (wallets.length === 0) {
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy) {
        const id = crypto.randomUUID();
        wallets = [{ id, name: 'My Wallet', mnemonic: legacy }];
        localStorage.setItem(WALLETS_KEY, JSON.stringify(wallets));
        localStorage.setItem(ACTIVE_WALLET_KEY, id);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      }
    }

    if (wallets.length > 0) {
      setWalletList(wallets);
      const savedActiveId = localStorage.getItem(ACTIVE_WALLET_KEY);
      setActiveWalletId(wallets.find(w => w.id === savedActiveId)?.id ?? wallets[0].id);
      const hasEncrypted = wallets.some(w => w.encryptedMnemonic);
      if (hasEncrypted) {
        setUnlockMode('unlock');
      } else {
        // All wallets are legacy plaintext — force encryption migration
        setUnlockMode('migrate');
      }
    }
  }, []);

  useEffect(() => {
    checkNodeSync(NODE_URL, 'Node')
      .then(setNodeStatus)
      .catch(() => setNodeStatus(FAILED_STATUS(NODE_URL)));
    const interval = setInterval(() => {
      checkNodeSync(NODE_URL, 'Node')
        .then(setNodeStatus)
        .catch(() => setNodeStatus(FAILED_STATUS(NODE_URL)));
    }, 60_000);
    return () => clearInterval(interval);
  }, []);

  // Activity tracking for idle auto-lock
  useEffect(() => {
    const update = () => { lastActivityRef.current = Date.now(); };
    window.addEventListener('mousemove', update, { passive: true });
    window.addEventListener('keydown', update, { passive: true });
    window.addEventListener('click', update, { passive: true });
    window.addEventListener('touchstart', update, { passive: true });
    return () => {
      window.removeEventListener('mousemove', update);
      window.removeEventListener('keydown', update);
      window.removeEventListener('click', update);
      window.removeEventListener('touchstart', update);
    };
  }, []);

  // Idle auto-lock interval
  useEffect(() => {
    if (!sessionKey || !idleLockMinutes) return;
    const interval = setInterval(() => {
      if (Date.now() - lastActivityRef.current > idleLockMinutes * 60 * 1000) {
        setSessionKey(null);
        setUnlockMode('unlock');
      }
    }, 30_000);
    return () => clearInterval(interval);
  }, [sessionKey, idleLockMinutes]);

  const handleUnlock = async (key: CryptoKey, updatedWallets?: WalletEntry[]) => {
    const list = updatedWallets ?? walletList;
    if (updatedWallets) {
      setWalletList(updatedWallets);
      localStorage.setItem(WALLETS_KEY, JSON.stringify(updatedWallets));
    }
    setSessionKey(key);
    setUnlockMode(null);
    const savedActiveId = localStorage.getItem(ACTIVE_WALLET_KEY);
    const active = list.find(w => w.id === savedActiveId) ?? list[0];
    setActiveWalletId(active.id);
    const { deriveAddresses } = await import('./lib/keys');
    try {
      const mnemonic = active.encryptedMnemonic
        ? await decryptMnemonic(active.encryptedMnemonic, key)
        : active.mnemonic!;
      const addresses = deriveAddresses(mnemonic, 50);
      const primary = addresses[0]?.address || '';
      try { localStorage.setItem('chia_primary_address', primary); } catch {}
      try { localStorage.setItem('chia_primary_puzzle_hash', addresses[0]?.puzzleHashHex || ''); } catch {}
      // Cache so profile page can switch wallets without decrypting
      if (primary && !active.primaryAddress) {
        const patched = list.map(w => w.id === active.id ? { ...w, primaryAddress: primary } : w);
        setWalletList(patched);
        localStorage.setItem(WALLETS_KEY, JSON.stringify(patched));
      }
      setWallet({ mnemonic, addresses });
      const returnUrl = sessionStorage.getItem('chia_return_url');
      if (returnUrl) { sessionStorage.removeItem('chia_return_url'); window.location.replace(returnUrl); return; }
      setScreen('wallet');
    } catch {
      localStorage.removeItem(WALLETS_KEY);
      localStorage.removeItem(ACTIVE_WALLET_KEY);
      localStorage.removeItem(VAULT_SALT_KEY);
      setWalletList([]);
      setSessionKey(null);
      setUnlockMode(null);
    }
  };

  const handleWalletReady = async (mnemonic: string, key: CryptoKey) => {
    setSessionKey(key);
    const encrypted = await encryptMnemonic(mnemonic, key);
    const { deriveAddresses } = await import('./lib/keys');
    const addresses = deriveAddresses(mnemonic, 50);
    const newEntry: WalletEntry = {
      id: crypto.randomUUID(),
      name: `Wallet ${walletList.length + 1}`,
      encryptedMnemonic: encrypted,
      primaryAddress: addresses[0]?.address || '',
    };
    const next = [...walletList, newEntry];
    setWalletList(next);
    setActiveWalletId(newEntry.id);
    localStorage.setItem(WALLETS_KEY, JSON.stringify(next));
    localStorage.setItem(ACTIVE_WALLET_KEY, newEntry.id);
    // Show backup reminder only when creating the very first wallet
    if (walletList.length === 0) {
      try { localStorage.setItem('chia_backup_reminder', 'pending'); } catch {}
      setShowBackupBanner(true);
    }
    setUnlockMode(null);
    try { localStorage.setItem('chia_primary_address', addresses[0]?.address || ''); } catch {}
    try { localStorage.setItem('chia_primary_puzzle_hash', addresses[0]?.puzzleHashHex || ''); } catch {}
    setWallet({ mnemonic, addresses });
    const returnUrl = sessionStorage.getItem('chia_return_url');
    if (returnUrl) { sessionStorage.removeItem('chia_return_url'); window.location.replace(returnUrl); return; }
    setScreen('wallet');
  };

  const handleDismissBackupBanner = () => {
    try { localStorage.setItem('chia_backup_reminder', 'dismissed'); } catch {}
    setShowBackupBanner(false);
  };

  const handleIdleLockChange = (minutes: number) => {
    setIdleLockMinutes(minutes);
    localStorage.setItem(IDLE_LOCK_KEY, String(minutes));
    lastActivityRef.current = Date.now();
  };

  const handleForgotPassword = () => {
    localStorage.removeItem(WALLETS_KEY);
    localStorage.removeItem(ACTIVE_WALLET_KEY);
    localStorage.removeItem(VAULT_SALT_KEY);
    localStorage.removeItem(ADDRESS_BOOK_KEY);
    setWalletList([]);
    setActiveWalletId(null);
    setWallet(null);
    setSessionKey(null);
    setUnlockMode(null);
    setNodeStatus(null);
    setAddressBook([]);
    setScreen('setup');
  };

  const handleChangePassword = (newKey: CryptoKey, updatedWallets: WalletEntry[]) => {
    setSessionKey(newKey);
    setWalletList(updatedWallets);
    localStorage.setItem(WALLETS_KEY, JSON.stringify(updatedWallets));
  };

  const handleSwitchWallet = async (id: string) => {
    const entry = walletList.find(w => w.id === id);
    if (!entry) return;
    const { deriveAddresses } = await import('./lib/keys');
    const mnemonic = entry.encryptedMnemonic && sessionKey
      ? await decryptMnemonic(entry.encryptedMnemonic, sessionKey)
      : entry.mnemonic!;
    const addresses = deriveAddresses(mnemonic, 50);
    const primary = addresses[0]?.address || '';
    // Cache primary address so the profile page can switch without decrypting
    if (primary && !entry.primaryAddress) {
      const updated = walletList.map(w => w.id === id ? { ...w, primaryAddress: primary } : w);
      setWalletList(updated);
      localStorage.setItem(WALLETS_KEY, JSON.stringify(updated));
    }
    try { localStorage.setItem('chia_primary_address', primary); } catch {}
    try { localStorage.setItem('chia_primary_puzzle_hash', addresses[0]?.puzzleHashHex || ''); } catch {}
    setWallet({ mnemonic, addresses });
    setActiveWalletId(id);
    localStorage.setItem(ACTIVE_WALLET_KEY, id);
    setScreen('wallet');
    setRefreshKey(k => k + 1);
  };

  const handleRemoveWallet = async (id: string) => {
    const next = walletList.filter(w => w.id !== id);
    if (next.length === 0) {
      localStorage.removeItem(WALLETS_KEY);
      localStorage.removeItem(ACTIVE_WALLET_KEY);
      localStorage.removeItem(ADDRESS_BOOK_KEY);
      localStorage.removeItem(VAULT_SALT_KEY);
      setWalletList([]);
      setActiveWalletId(null);
      setWallet(null);
      setSessionKey(null);
      setUnlockMode(null);
      setScreen('setup');
      setNodeStatus(null);
      setAddressBook([]);
    } else {
      localStorage.setItem(WALLETS_KEY, JSON.stringify(next));
      setWalletList(next);
      if (id === activeWalletId) {
        const switchTo = next[0];
        const { deriveAddresses } = await import('./lib/keys');
        const mnemonic = switchTo.encryptedMnemonic && sessionKey
          ? await decryptMnemonic(switchTo.encryptedMnemonic, sessionKey)
          : switchTo.mnemonic!;
        setWallet({ mnemonic, addresses: deriveAddresses(mnemonic, 50) });
        setActiveWalletId(switchTo.id);
        localStorage.setItem(ACTIVE_WALLET_KEY, switchTo.id);
        setScreen('wallet');
        setRefreshKey(k => k + 1);
      }
    }
  };

  const handleRenameWallet = (id: string, name: string) => {
    if (!name.trim()) return;
    const next = walletList.map(w => w.id === id ? { ...w, name: name.trim() } : w);
    setWalletList(next);
    localStorage.setItem(WALLETS_KEY, JSON.stringify(next));
  };

  const handleAddBookEntry = (label: string, address: string) => {
    const next = [...addressBook, { id: crypto.randomUUID(), label, address }];
    setAddressBook(next);
    localStorage.setItem(ADDRESS_BOOK_KEY, JSON.stringify(next));
  };

  const handleRemoveBookEntry = (id: string) => {
    const next = addressBook.filter(e => e.id !== id);
    setAddressBook(next);
    localStorage.setItem(ADDRESS_BOOK_KEY, JSON.stringify(next));
  };

  const handleToggleHideSmall = (value: boolean) => {
    setHideSmallBalances(value);
    localStorage.setItem(HIDE_SMALL_KEY, value ? '1' : '0');
  };



  const isWallet = wallet !== null;

  const activeWalletName = walletList.find(w => w.id === activeWalletId)?.name;

  const showSidebar = isWallet && !unlockMode && screen !== 'setup';

  return (
    <div className="app">
      <TopNav activePath="/" />

      {isWallet && (
        <div className="node-bar">
          {walletList.length > 1 && activeWalletName && (
            <span style={{fontSize:11,color:'var(--text-secondary)',marginRight:'auto'}}>{activeWalletName}</span>
          )}
          <NodeBadge status={nodeStatus}/>
        </div>
      )}

      {isWallet && showBackupBanner && (
        <div className="backup-banner">
          <span style={{fontSize:16}}>🔐</span>
          <span style={{flex:1,fontSize:12,color:'var(--text-primary)',lineHeight:1.4}}>
            Back up your seed phrase — it's the only way to recover this wallet.
          </span>
          <button onClick={handleDismissBackupBanner}
            style={{background:'none',border:'none',color:'var(--text-secondary)',
              cursor:'pointer',fontSize:18,padding:0,lineHeight:1}}>×</button>
        </div>
      )}

      <div className="wallet-body">
        {showSidebar && (
          <nav className="sidebar-nav">
            <button className={`sidebar-item ${screen==='wallet'?'active':''}`} onClick={()=>setScreen('wallet')}><IconHome/><span>Home</span></button>
            <button className={`sidebar-item ${screen==='send'?'active':''}`} onClick={()=>setScreen('send')}><IconSend/><span>Send</span></button>
            <button className={`sidebar-item ${screen==='receive'?'active':''}`} onClick={()=>setScreen('receive')}><IconReceive/><span>Receive</span></button>
            <button className={`sidebar-item ${screen==='nfts'?'active':''}`} onClick={()=>setScreen('nfts')}><IconNft/><span>NFTs</span></button>
            <button className={`sidebar-item ${screen==='history'?'active':''}`} onClick={()=>setScreen('history')}><IconHistory/><span>History</span></button>
            <button className={`sidebar-item ${screen==='offers'?'active':''}`} onClick={()=>setScreen('offers')}><IconTrade/><span>Trade</span></button>
            <button className={`sidebar-item ${screen==='settings'?'active':''}`} onClick={()=>setScreen('settings')}><IconSettings/><span>Settings</span></button>
          </nav>
        )}

        <div className="wallet-content">
          {unlockMode && <LockScreen mode={unlockMode} walletList={walletList} onUnlock={handleUnlock} onForgotPassword={handleForgotPassword}/>}
          {!unlockMode && screen==='setup' && <SetupScreen onWalletReady={handleWalletReady} onCancel={isWallet ? () => setScreen('settings') : undefined} existingKey={sessionKey}/>}
          {isWallet && screen==='wallet'   && <WalletHome wallet={wallet} nodeUrl={nodeUrl} refreshKey={refreshKey} onSendSuccess={()=>setRefreshKey(k=>k+1)} hideSmallBalances={hideSmallBalances} onCatBalancesChange={setCatBalances}/>}
          {isWallet && screen==='send'     && <SendScreen wallet={wallet!} onSendSuccess={()=>setRefreshKey(k=>k+1)} addressBook={addressBook} onTxConfirmed={showToast}/>}
          {isWallet && screen==='receive'  && <ReceiveScreen wallet={wallet}/>}
          {isWallet && screen==='nfts'     && <NftsScreen wallet={wallet!}/>}
          {isWallet && screen==='history'  && <HistoryScreen wallet={wallet} nodeUrl={nodeUrl} catBalances={catBalances}/>}
          {isWallet && screen==='offers'   && <OffersScreen catBalances={catBalances}/>}
          {isWallet && screen==='settings' && <SettingsScreen onRemoveWallet={handleRemoveWallet} onSwitchWallet={handleSwitchWallet} onRenameWallet={handleRenameWallet} onAddWallet={() => setScreen('setup')} walletList={walletList} activeWalletId={activeWalletId} addressBook={addressBook} onAddEntry={handleAddBookEntry} onRemoveEntry={handleRemoveBookEntry} hideSmallBalances={hideSmallBalances} onToggleHideSmall={handleToggleHideSmall} currentMnemonic={wallet?.mnemonic ?? ''} idleLockMinutes={idleLockMinutes} onIdleLockChange={handleIdleLockChange} sessionKey={sessionKey} onChangePassword={handleChangePassword}/>}
        </div>
      </div>

      {toast && (
        <div className="toast-msg">✓ {toast}</div>
      )}

      {isWallet && screen !== 'setup' && (
        <div className="bottom-nav">
          <button className={`nav-item ${screen==='wallet'?'active':''}`} onClick={()=>setScreen('wallet')}><IconHome/>Home</button>
          <button className={`nav-item ${screen==='send'?'active':''}`} onClick={()=>setScreen('send')}><IconSend/>Send</button>
          <button className={`nav-item ${screen==='receive'?'active':''}`} onClick={()=>setScreen('receive')}><IconReceive/>Receive</button>
          <button className={`nav-item ${screen==='nfts'?'active':''}`} onClick={()=>setScreen('nfts')}><IconNft/>NFTs</button>
          <button className={`nav-item ${screen==='history'?'active':''}`} onClick={()=>setScreen('history')}><IconHistory/>History</button>
          <button className={`nav-item ${screen==='offers'?'active':''}`} onClick={()=>setScreen('offers')}><IconTrade/>Trade</button>
          <button className={`nav-item ${screen==='settings'?'active':''}`} onClick={()=>setScreen('settings')}><IconSettings/>Settings</button>
        </div>
      )}
    </div>
  );
}