import React, { useState, useEffect, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import './App.css';
import type { DerivedAddress } from './lib/keys';
import { formatMojoToXch, isValidXchAddress } from './lib/utils';
import {
  checkNodeSync,
  getBalance,
  type NodeStatus,
} from './lib/node';
import {
  getCatBalances,
  formatCatAmount,
  fetchXchPrice,
  formatCatUsdValue,
  loadCustomAssetIds,
  saveCustomAssetIds,
  type CatBalance,
} from './lib/cats';
import { sendXch } from './lib/spend';

type Screen = 'setup' | 'wallet' | 'nfts' | 'send' | 'receive' | 'history' | 'settings';

interface WalletState {
  mnemonic: string;
  addresses: DerivedAddress[];
}

interface WalletEntry {
  id: string;
  name: string;
  mnemonic: string;
}

interface AddressEntry {
  id: string;
  label: string;
  address: string;
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
const IconNFTs = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
    <rect x="3" y="3" width="7" height="7" rx="1" strokeLinecap="round"/>
    <rect x="14" y="3" width="7" height="7" rx="1" strokeLinecap="round"/>
    <rect x="3" y="14" width="7" height="7" rx="1" strokeLinecap="round"/>
    <rect x="14" y="14" width="7" height="7" rx="1" strokeLinecap="round"/>
  </svg>
);
const IconHistory = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
    <circle cx="12" cy="12" r="9"/>
    <path d="M12 7v5l3 3" strokeLinecap="round" strokeLinejoin="round"/>
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

function SetupScreen({ onWalletReady, onCancel }: { onWalletReady: (w: WalletState) => void; onCancel?: () => void }) {
  const [mode, setMode] = useState<'choose'|'new'|'import'>('choose');
  const [mnemonic, setMnemonic] = useState('');
  const [importInput, setImportInput] = useState('');
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  const handleGenerate = async () => {
    const { generateNewMnemonic } = await import('./lib/keys');
    setMnemonic(generateNewMnemonic()); setMode('new');
  };

  const handleConfirmNew = async () => {
    try {
      const { deriveAddresses } = await import('./lib/keys');
      const addresses = deriveAddresses(mnemonic, 50);
      onWalletReady({ mnemonic, addresses });
    } catch(e: any) { setError(`Failed: ${e.message}`); }
  };

  const handleImport = async () => {
    setError('');
    const cleaned = importInput.trim().toLowerCase().replace(/\s+/g, ' ');
    const words = cleaned.split(' ').filter(Boolean);
    if (words.length !== 24) { setError('Invalid mnemonic. Check for typos — must be 24 valid BIP39 words.'); return; }
    const { validateMnemonicWords, deriveAddresses } = await import('./lib/keys');
    if (!validateMnemonicWords(cleaned)) { setError('Invalid mnemonic. Check for typos — must be 24 valid BIP39 words.'); return; }
    try { onWalletReady({ mnemonic: cleaned, addresses: deriveAddresses(cleaned, 50) }); }
    catch (e: any) { setError(`Key derivation failed: ${e.message}`); }
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
        <button className="btn btn-primary" disabled={!confirmed} onClick={handleConfirmNew}>Open Wallet</button>
        <button className="btn btn-secondary mt-8" onClick={()=>setMode('choose')}>Back</button>
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

function WalletHome({ wallet, nodeUrl, refreshKey, onSendSuccess, hideSmallBalances }: {
  wallet: WalletState; nodeUrl: string; refreshKey: number; onSendSuccess: () => void; hideSmallBalances: boolean;
}) {
  const [loading, setLoading] = useState(true);
  const [proxyError, setProxyError] = useState('');
  const [copied, setCopied] = useState(false);
  const [xchPrice, setXchPrice] = useState(0);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [catBalances, setCatBalances] = useState<CatBalance[]>([]);
  const [selectedCat, setSelectedCat] = useState<CatBalance | null>(null);
  const primaryAddress = wallet.addresses[0]?.address || '';

  const fetchAll = useCallback(async () => {
    if (!nodeUrl) { setLoading(false); return; }
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
      const cats = await getCatBalances(nodeUrl, puzzleHashes, xch);
      setCatBalances(cats);
    } catch (e: any) {
      if (balance === null) setProxyError('Cannot reach proxy. Is it running on localhost:3001?');
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

  const handleCopy = () => { navigator.clipboard.writeText(primaryAddress); setCopied(true); setTimeout(()=>setCopied(false),2000); };
  const xchDisplay = balance !== null ? formatMojoToXch(balance) : null;

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
            {nodeUrl ? 'Fetching balance…' : 'Set a node in Settings to load balance'}
          </div>
        ) : (
          <>
            <div className="balance-amount">{xchDisplay ?? '—'}<span className="balance-unit">XCH</span></div>
            {balance !== null && xchPrice > 0 && (
              <div style={{fontSize:20,color:'var(--text-secondary)',marginTop:4}}>
                ${(Number(balance)/1_000_000_000_000*xchPrice).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}
              </div>
            )}
          </>
        )}
      </div>

      {/* Address */}
      <div>
        <div className="section-label">Your Address</div>
        <div className="address-card">
          <div className="address-text">
            <span>{primaryAddress.slice(0,10)}</span>{primaryAddress.slice(10,-8)}<span>{primaryAddress.slice(-8)}</span>
          </div>
          <button className={`copy-btn ${copied?'copied':''}`} onClick={handleCopy}>{copied?'Copied!':'Copy'}</button>
        </div>
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
  const displayed = showAll ? wallet.addresses.slice(0, 20) : wallet.addresses.slice(0, 3);
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

function SettingsScreen({ nodeUrl, nodeStatus, onNodeChange, onRemoveWallet, onSwitchWallet, onRenameWallet, onAddWallet, walletList, activeWalletId, addressBook, onAddEntry, onRemoveEntry, hideSmallBalances, onToggleHideSmall }:
  { nodeUrl: string; nodeStatus: NodeStatus|null; onNodeChange:(url:string)=>void;
    onRemoveWallet:(id:string)=>void; onSwitchWallet:(id:string)=>void;
    onRenameWallet:(id:string,name:string)=>void; onAddWallet:()=>void;
    walletList: WalletEntry[]; activeWalletId: string|null;
    addressBook: AddressEntry[]; onAddEntry:(label:string,address:string)=>void; onRemoveEntry:(id:string)=>void;
    hideSmallBalances: boolean; onToggleHideSmall:(v:boolean)=>void }) {
  const [input, setInput] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<NodeStatus|null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [newAddress, setNewAddress] = useState('');
  const [addError, setAddError] = useState('');
  const [confirmRemoveId, setConfirmRemoveId] = useState<string|null>(null);
  const [editingNameId, setEditingNameId] = useState<string|null>(null);
  const [editingName, setEditingName] = useState('');
  const [customTokens, setCustomTokens] = useState<string[]>(() => loadCustomAssetIds());
  const [newAssetId, setNewAssetId] = useState('');
  const [assetIdError, setAssetIdError] = useState('');

  useEffect(() => {
    setInput(nodeUrl || '');
  }, [nodeUrl]);

  const handleTest = async () => {
    setTesting(true); setTestResult(null);
    try {
      const result = await checkNodeSync(input, 'Custom node');
      setTestResult(result);
    } catch(e: any) {
      setTestResult({ url: input, label: 'Custom node', peakHeight: 0, synced: false, latencyMs: 0, trusted: false, error: e.message });
    }
    setTesting(false);
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

      <div className="section-label mt-16">Node Configuration</div>
      <div className="node-config">
        <div style={{fontSize:12,color:'var(--text-secondary)',lineHeight:1.6}}>
          Point to any Chia full node RPC with CORS enabled. The wallet verifies sync state before trusting it.
        </div>
        <input type="url" value={input} onChange={e=>setInput(e.target.value)} placeholder="http://localhost:3001"/>
        <div style={{display:'flex',gap:8}}>
          <button className="btn btn-secondary" style={{flex:1,padding:'10px'}} onClick={handleTest} disabled={testing}>
            {testing?'Testing…':'Test node'}
          </button>
          <button className="btn btn-primary" style={{flex:1,padding:'10px'}} onClick={()=>onNodeChange(input)}>Save</button>
        </div>
        {testResult && (
          <div style={{fontSize:12,color:testResult.trusted?'var(--accent)':'var(--error)'}}>
            {testResult.trusted
              ? `✓ Synced — peak #${testResult.peakHeight.toLocaleString()} (${testResult.latencyMs}ms)`
              : `✗ ${testResult.error}`}
          </div>
        )}
      </div>

      <div className="section-label mt-16">Current Node</div>
      <div className="node-config">
        <div style={{fontSize:12,fontFamily:'var(--font-mono)',color:'var(--text-secondary)',wordBreak:'break-all'}}>
          {nodeUrl || 'No node configured'}
        </div>
        {nodeStatus && (
          <div style={{fontSize:12,color:nodeStatus.trusted?'var(--accent)':'var(--error)'}}>
            {nodeStatus.trusted
              ? `✓ Synced · Block #${nodeStatus.peakHeight.toLocaleString()} · ${nodeStatus.latencyMs}ms`
              : `✗ ${nodeStatus.error}`}
          </div>
        )}
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
    </div>
  );
}

// Token avatar — colored circle with ticker initials, or actual logo
function TokenAvatar({ ticker, logoUrl }: { ticker: string; logoUrl?: string }) {
  const [imgFailed, setImgFailed] = useState(false);
  const colors = [
    '#4daa87', '#e07b3a', '#7b6fd8', '#d85c8a',
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

interface NftData {
  nft_id: string;
  nft_coin_id: string;
  launcher_id: string;
  data_uris: string[];
  metadata_uris: string[];
  mint_height: number;
  royalty_percentage?: number;
  name?: string;
  description?: string;
  collection?: string;
  preview_url?: string;
  is_video?: boolean;
}

const WALLET_PROXY = 'http://localhost:3001';

async function walletRpc(endpoint: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${WALLET_PROXY}/wallet/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
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

function resolveUri(uri: string): string {
  if (uri.startsWith('ipfs://')) return uri.replace('ipfs://', 'https://ipfs.mintgarden.io/ipfs/');
  return uri;
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
        <div style={{background:'rgba(77,170,135,0.07)',border:'1px solid var(--accent)',
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
            <div style={{padding:'12px',background:'rgba(77,170,135,0.1)',
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

async function fetchNftMetadata(nft: NftData): Promise<NftData> {
  const dataUri = nft.data_uris?.[0] || '';
  const isVideo = dataUri.match(/\.(mp4|webm|mov|avi)(\?|$)/i) !== null;

  let name = nft.name;
  let description = nft.description;
  let collection = nft.collection;
  let preview_url: string | undefined;

  if (nft.metadata_uris?.length) {
    const url = resolveUri(nft.metadata_uris[0]);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const meta = await res.json();
        name = meta.name;
        description = meta.description;
        collection = meta.collection?.name || meta.series_name || meta.collection;
        // Many collections store a preview image separately
        preview_url = meta.preview_image_url || meta.preview_url ||
                      meta.image || meta.thumbnail_url || undefined;
        if (preview_url) preview_url = resolveUri(preview_url);
      }
    } catch { /* fall through */ }
  }

  return { ...nft, name, description, collection, is_video: isVideo, preview_url };
}

function NFTDetailView({ nft, onBack }: { nft: NftData; onBack: () => void }) {
  const [transferring, setTransferring] = useState(false);
  const [toAddress, setToAddress] = useState('');
  const [fee, setFee] = useState('0.00005');
  const [status, setStatus] = useState<'idle'|'sending'|'success'|'error'>('idle');
  const [message, setMessage] = useState('');
  const [nftIdCopied, setNftIdCopied] = useState(false);
  const sendingRef = React.useRef(false);

  const handleCopyNftId = () => {
    navigator.clipboard.writeText(nft.nft_id);
    setNftIdCopied(true);
    setTimeout(() => setNftIdCopied(false), 2000);
  };

  const isValidAddress = isValidXchAddress(toAddress);
  const feeNftF = parseFloat(fee || '0');
  const feeMojo = BigInt(isNaN(feeNftF) ? 0 : Math.round(feeNftF * 1_000_000_000_000));

  async function handleTransfer() {
    if (!isValidAddress || sendingRef.current) return;
    sendingRef.current = true;
    setStatus('sending');
    setMessage('');
    try {
      // Find the NFT wallet that owns this coin
      const walletsRes = await walletRpc('get_wallets', { include_data: true });
      if (!walletsRes.success) throw new Error('Could not load wallets');
      const nftWallets: any[] = (walletsRes.wallets || []).filter((w: any) => w.type === 10);
      let ownerWalletId: number | null = null;
      for (const w of nftWallets) {
        const nftsRes = await walletRpc('nft_get_nfts', { wallet_id: w.id, start_index: 0, num: 200 });
        if (nftsRes.success && (nftsRes.nft_list || []).some((n: any) => n.nft_coin_id === nft.nft_coin_id)) {
          ownerWalletId = w.id;
          break;
        }
      }
      if (ownerWalletId === null) throw new Error('NFT not found in any wallet');
      const transferBody = `{"wallet_id":${ownerWalletId},"target_address":${JSON.stringify(toAddress)},"nft_coin_id":${JSON.stringify(nft.nft_coin_id)},"fee":${feeMojo}}`;
      const res = await fetch(`${WALLET_PROXY}/wallet/nft_transfer_nft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: transferBody,
        signal: AbortSignal.timeout(30000),
      }).then(r => r.json());
      if (res.success) {
        setStatus('success');
        setMessage('NFT transferred successfully!');
        setToAddress('');
      } else {
        setStatus('error');
        setMessage(res.error || 'Transfer failed');
      }
    } catch (e: any) {
      setStatus('error');
      setMessage(e.message);
    } finally {
      sendingRef.current = false;
    }
  }

  const mediaUrl = nft.preview_url || resolveUri(nft.data_uris?.[0] || '');

  return (
    <div className="wallet-screen">
      <button onClick={onBack} style={{
        background:'none',border:'none',color:'var(--accent)',
        fontSize:13,cursor:'pointer',textAlign:'left',padding:0,marginBottom:4
      }}>← Back</button>

      {/* Media */}
      <div style={{borderRadius:16,overflow:'hidden',border:'1px solid var(--border)'}}>
        {nft.is_video && nft.data_uris?.[0] ? (
          <video src={resolveUri(nft.data_uris[0])}
            style={{width:'100%',aspectRatio:'1',objectFit:'cover',display:'block'}}
            autoPlay loop muted playsInline controls/>
        ) : mediaUrl ? (
          <img src={mediaUrl} alt={nft.name || ''}
            style={{width:'100%',aspectRatio:'1',objectFit:'cover',display:'block'}}
            onError={e => (e.currentTarget.style.display='none')}/>
        ) : null}
      </div>

      {/* Info */}
      <div style={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:12,padding:'14px 16px'}}>
        <div style={{fontWeight:700,fontSize:16,color:'var(--text-primary)',marginBottom:2}}>
          {nft.name || 'Unknown NFT'}
        </div>
        {nft.collection && (
          <div style={{fontSize:12,color:'var(--accent)',marginBottom:8}}>{nft.collection}</div>
        )}
        {nft.description && (
          <div style={{fontSize:12,color:'var(--text-secondary)',lineHeight:1.6,marginBottom:10}}>
            {nft.description}
          </div>
        )}
        {nft.royalty_percentage && (
          <div style={{fontSize:11,color:'var(--text-dim)',marginBottom:4}}>
            Royalty: {(nft.royalty_percentage / 100).toFixed(1)}%
          </div>
        )}
        <div style={{display:'flex',alignItems:'flex-start',gap:8,marginTop:4}}>
          <div style={{fontSize:10,color:'var(--text-dim)',fontFamily:'var(--font-mono)',
            wordBreak:'break-all',flex:1}}>
            {nft.nft_id}
          </div>
          <button className={`copy-btn ${nftIdCopied?'copied':''}`} onClick={handleCopyNftId}
            style={{flexShrink:0,fontSize:10,padding:'4px 8px'}}>
            {nftIdCopied?'✓':'Copy ID'}
          </button>
        </div>
        <div style={{fontSize:10,color:'var(--text-dim)',marginTop:2}}>
          Block #{nft.mint_height?.toLocaleString()}
        </div>
      </div>

      {/* Transfer */}
      {status === 'success' ? (
        <div style={{padding:'14px',background:'rgba(77,170,135,0.1)',border:'1px solid var(--accent)',
          borderRadius:12,fontSize:13,color:'var(--accent)',textAlign:'center'}}>
          ✓ {message}
        </div>
      ) : !transferring ? (
        <button onClick={() => setTransferring(true)} style={{
          width:'100%',padding:'14px',background:'var(--bg-card)',
          border:'1px solid var(--border)',borderRadius:12,
          color:'var(--text-primary)',fontWeight:600,fontSize:14,cursor:'pointer'
        }}>
          Transfer NFT →
        </button>
      ) : (
        <div style={{background:'var(--bg-card)',border:'1px solid var(--border)',
          borderRadius:12,padding:'14px 16px',display:'flex',flexDirection:'column',gap:10}}>
          <div style={{fontSize:12,fontWeight:600,color:'var(--text-secondary)',letterSpacing:'0.06em'}}>
            TRANSFER TO
          </div>
          <input
            className="address-input"
            placeholder="xch1…"
            value={toAddress}
            onChange={e => setToAddress(e.target.value.trim())}
            spellCheck={false}
          />
          <div style={{display:'flex',gap:10,alignItems:'center'}}>
            <div style={{fontSize:11,color:'var(--text-secondary)',flexShrink:0}}>FEE (XCH)</div>
            <input
              className="address-input"
              type="number"
              min="0"
              step="0.00001"
              value={fee}
              onChange={e => setFee(e.target.value)}
              style={{fontSize:13}}
            />
          </div>
          {status === 'error' && (
            <div style={{fontSize:12,color:'#ff6b6b',padding:'8px 10px',
              background:'rgba(220,50,50,0.1)',borderRadius:8}}>
              ✗ {message}
            </div>
          )}
          <div style={{display:'flex',gap:8}}>
            <button onClick={() => { setTransferring(false); setStatus('idle'); setMessage(''); }}
              style={{flex:1,padding:'11px',background:'none',border:'1px solid var(--border)',
                borderRadius:10,color:'var(--text-secondary)',cursor:'pointer',fontSize:13}}>
              Cancel
            </button>
            <button onClick={handleTransfer}
              disabled={!isValidAddress || status === 'sending'}
              style={{flex:2,padding:'11px',
                background: isValidAddress && status !== 'sending' ? '#dc3232' : 'var(--bg-input)',
                border:'none',borderRadius:10,
                color: isValidAddress && status !== 'sending' ? '#fff' : 'var(--text-dim)',
                fontWeight:700,fontSize:13,cursor: isValidAddress ? 'pointer' : 'not-allowed'}}>
              {status === 'sending' ? '⏳ Sending…' : 'Confirm Transfer'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function NFTsScreen() {
  const [nfts, setNfts] = useState<NftData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<NftData | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError('');
      try {
        // Find all NFT wallets (type 10)
        const walletsRes = await walletRpc('get_wallets', { include_data: true });
        if (!walletsRes.success) throw new Error('Could not load wallets');
        const nftWallets = (walletsRes.wallets || []).filter((w: any) => w.type === 10);
        if (nftWallets.length === 0) { setNfts([]); setLoading(false); return; }

        // Fetch NFTs from all NFT wallets
        const allNfts: NftData[] = [];
        for (const wallet of nftWallets) {
          const res = await walletRpc('nft_get_nfts', { wallet_id: wallet.id, start_index: 0, num: 50 });
          if (res.success && res.nft_list) allNfts.push(...res.nft_list);
        }

        // Fetch metadata for each NFT in parallel
        const withMeta = await mapConcurrent(allNfts, 5, fetchNftMetadata);
        setNfts(withMeta);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (selected) return (
    <NFTDetailView
      nft={selected}
      onBack={() => { setSelected(null); }}
    />
  );

  return (
    <div className="wallet-screen">
      <div className="section-label">NFTs</div>
      {loading && <div className="balance-loading"><div className="spinner"/>Loading NFTs…</div>}
      {!loading && error && <div className="error-msg">{error}</div>}
      {!loading && !error && nfts.length === 0 && (
        <div className="empty-state">
          <div style={{fontSize:40,marginBottom:12}}>🖼️</div>
          No NFTs found in this wallet.
        </div>
      )}
      {nfts.length > 0 && (
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
          {nfts.map(nft => {
            const displayUrl = nft.preview_url || resolveUri(nft.data_uris?.[0] || '');
            return (
              <div key={nft.nft_id} onClick={() => setSelected(nft)}
                style={{background:'var(--bg-card)',border:'1px solid var(--border)',
                  borderRadius:12,overflow:'hidden',cursor:'pointer'}}>
                {nft.is_video && !nft.preview_url ? (
                  <div style={{width:'100%',aspectRatio:'1',background:'var(--bg-input)',
                    display:'flex',flexDirection:'column',alignItems:'center',
                    justifyContent:'center',fontSize:28,gap:6}}>
                    🎬
                    <div style={{fontSize:9,color:'var(--text-dim)'}}>Video NFT</div>
                  </div>
                ) : displayUrl ? (
                  <img src={displayUrl} alt={nft.name || ''}
                    style={{width:'100%',aspectRatio:'1',objectFit:'cover',display:'block'}}
                    onError={e => { (e.currentTarget as HTMLImageElement).style.display='none'; }}
                  />
                ) : (
                  <div style={{width:'100%',aspectRatio:'1',background:'var(--bg-input)',
                    display:'flex',alignItems:'center',justifyContent:'center',fontSize:32}}>🖼️</div>
                )}
                <div style={{padding:'8px 10px'}}>
                  <div style={{fontSize:12,fontWeight:600,color:'var(--text-primary)',
                    overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                    {nft.name || nft.nft_id.slice(0, 12) + '…'}
                  </div>
                  {nft.collection && (
                    <div style={{fontSize:10,color:'var(--accent)',marginTop:2,
                      overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                      {nft.collection}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


interface TxRecord {
  name: string;
  type: number;
  amount: number;
  fee_amount: number;
  confirmed: boolean;
  confirmed_at_height: number;
  created_at_time: number;
  to_address: string;
  walletLabel?: string; // 'XCH' or CAT name
  isCat?: boolean;
}

const TX_PAGE_SIZE = 20;

function HistoryScreen() {
  const [txs, setTxs] = useState<TxRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        // Get all daemon wallets (XCH + registered CATs)
        const walletsRes = await getDaemonWallets();
        const relevantWallets = walletsRes.filter((w: any) => w.type === 1 || w.type === 6);

        const allTxs = await Promise.allSettled(
          relevantWallets.map(async (w: any) => {
            const res = await walletRpc('get_transactions', {
              wallet_id: w.id, start: 0, end: TX_PAGE_SIZE,
              sort_key: 'CONFIRMED_AT_HEIGHT', reverse: true,
            });
            if (!res.success) return [];
            return (res.transactions || []).map((tx: TxRecord) => ({
              ...tx,
              walletLabel: w.type === 1 ? 'XCH' : (w.name || 'Token'),
              isCat: w.type === 6,
            }));
          })
        );

        const merged: TxRecord[] = allTxs
          .filter((r): r is PromiseFulfilledResult<TxRecord[]> => r.status === 'fulfilled')
          .flatMap(r => r.value);

        merged.sort((a, b) => b.confirmed_at_height - a.confirmed_at_height || b.created_at_time - a.created_at_time);
        setTxs(merged.slice(0, TX_PAGE_SIZE * 2));
      } catch (e: any) {
        setError(e.message);
      }
    })().finally(() => setLoading(false));
  }, []);

  return (
    <div className="wallet-screen">
      <div className="section-label">Transaction History</div>
      {loading && <div className="balance-loading"><div className="spinner"/>Loading…</div>}
      {!loading && error && <div className="error-msg">{error}</div>}
      {!loading && !error && txs.length === 0 && (
        <div className="empty-state">
          <div style={{fontSize:36,marginBottom:12}}>🧾</div>
          No transactions yet.
        </div>
      )}
      {txs.map((tx, idx) => {
        const isSend = tx.type === 2 || tx.type === 6;
        const label = tx.walletLabel || 'XCH';
        const amount = tx.isCat
          ? formatCatAmount(BigInt(tx.amount))
          : formatMojoToXch(BigInt(tx.amount));
        const date = new Date(tx.created_at_time * 1000);
        const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        const addr = tx.to_address;
        return (
          <div key={`${tx.name}-${idx}`} className="tx-row">
            <div className={`tx-icon ${isSend ? 'tx-send' : 'tx-recv'}`}>
              {isSend ? '↑' : '↓'}
            </div>
            <div className="tx-info">
              <div className="tx-top">
                <span className="tx-type">{isSend ? 'Sent' : 'Received'}</span>
                <span className={`tx-amount ${isSend ? 'tx-amount-send' : 'tx-amount-recv'}`}>
                  {isSend ? '−' : '+'}{amount} {label}
                </span>
              </div>
              <div className="tx-bottom">
                <span className="tx-date">{dateStr} · {timeStr}</span>
                {!tx.confirmed && <span className="tx-pending">pending</span>}
                {tx.confirmed && (
                  <a href={`https://www.spacescan.io/tx/${tx.name}`} target="_blank" rel="noopener noreferrer"
                    style={{fontSize:10,color:'var(--accent)',textDecoration:'none',marginLeft:6}}
                    onClick={e => e.stopPropagation()}>
                    ↗ Explorer
                  </a>
                )}
              </div>
              {isSend && addr && (
                <div className="tx-address">→ {addr.slice(0, 10)}…{addr.slice(-6)}</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SendScreen({ nodeUrl, onSendSuccess, addressBook }: {
  nodeUrl: string;
  onSendSuccess: () => void;
  addressBook: AddressEntry[];
}) {
  const [toAddress, setToAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [fee, setFee] = useState('0.00005');
  const [status, setStatus] = useState<'idle' | 'sending' | 'pending' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [balance, setBalance] = useState<bigint | null>(null);
  const [balanceError, setBalanceError] = useState('');
  const [showBook, setShowBook] = useState(false);
  const sendingRef = React.useRef(false);
  const pollTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch('http://localhost:3001/wallet/get_wallet_balance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet_id: 1 }),
      signal: AbortSignal.timeout(8000),
    })
      .then(r => r.json())
      .then(d => {
        if (d.success) { setBalance(BigInt(d.wallet_balance.spendable_balance)); setBalanceError(''); }
      })
      .catch(() => { setBalanceError('Cannot reach proxy (localhost:3001). Is it running?'); });
  }, [status]);

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
          setStatus('success');
          setMessage(`Sent ${formatMojoToXch(amountMojo)} XCH — confirmed at block #${res.transaction.confirmed_at_height?.toLocaleString()}`);
          onSendSuccess();
          return;
        }
      } catch { /* keep polling */ }
      pollConfirmation(txId, attempts + 1);
    }, 5000);
  }

  async function handleSend() {
    if (!isValid || !nodeUrl || sendingRef.current) return;
    sendingRef.current = true;
    setStatus('sending');
    setMessage('');
    try {
      const result = await sendXch({ toAddress, amountMojo, feeMojo, nodeUrl });
      if (result.success) {
        setToAddress('');
        setAmount('');
        if (result.txId && result.txId !== 'submitted') {
          setStatus('pending');
          setMessage(result.txId);
          pollConfirmation(result.txId);
        } else {
          setStatus('success');
          setMessage(`Sent ${formatMojoToXch(amountMojo)} XCH`);
          onSendSuccess();
        }
      } else {
        setStatus('error');
        setMessage(result.error || 'Transaction failed');
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

        <button
          onClick={handleSend}
          disabled={!isValid || isBusy || !nodeUrl}
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
          <div style={{padding: '12px', background: 'rgba(77,170,135,0.06)', border: '1px solid var(--accent)', borderRadius: 8, fontSize: 13, color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 10}}>
            <div className="spinner" style={{borderTopColor: 'var(--accent)'}}/>
            Pending confirmation…
          </div>
        )}
        {status === 'success' && (
          <div style={{padding: '12px', background: 'rgba(77,170,135,0.1)', border: '1px solid var(--accent)', borderRadius: 8, fontSize: 13, color: 'var(--accent)'}}>
            ✓ {message}
          </div>
        )}
        {status === 'error' && (
          <div style={{padding: '12px', background: 'rgba(220,50,50,0.1)', border: '1px solid #dc3232', borderRadius: 8, fontSize: 13, color: '#ff6b6b'}}>
            ✗ {message}
          </div>
        )}
        {!nodeUrl && (
          <div className="empty-state">Set a node in Settings to send.</div>
        )}
      </div>
    </div>
  );
}

const WALLETS_KEY = 'chia_wallets';
const ACTIVE_WALLET_KEY = 'chia_active_wallet';
const LEGACY_STORAGE_KEY = 'chia_wallet_mnemonic';
const NODE_KEY = 'chia_node_url';
const ADDRESS_BOOK_KEY = 'chia_address_book';
const HIDE_SMALL_KEY = 'chia_hide_small';

export default function App() {
  const [wallet, setWallet] = useState<WalletState|null>(null);
  const [walletList, setWalletList] = useState<WalletEntry[]>([]);
  const [activeWalletId, setActiveWalletId] = useState<string|null>(null);
  const [screen, setScreen] = useState<Screen>('setup');
  const [nodeUrl, setNodeUrl] = useState<string>('');
  const [nodeStatus, setNodeStatus] = useState<NodeStatus|null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [addressBook, setAddressBook] = useState<AddressEntry[]>(() => {
    try { return JSON.parse(localStorage.getItem(ADDRESS_BOOK_KEY) || '[]'); }
    catch { return []; }
  });
  const [hideSmallBalances, setHideSmallBalances] = useState(() => localStorage.getItem(HIDE_SMALL_KEY) === '1');

  useEffect(() => {
    const savedNode = localStorage.getItem(NODE_KEY) || '';
    setNodeUrl(savedNode);

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
      const active = wallets.find(w => w.id === savedActiveId) ?? wallets[0];
      setActiveWalletId(active.id);
      import('./lib/keys').then(({ deriveAddresses }) => {
        try {
          setWallet({ mnemonic: active.mnemonic, addresses: deriveAddresses(active.mnemonic, 50) });
          setScreen('wallet');
        } catch {
          localStorage.removeItem(WALLETS_KEY);
          localStorage.removeItem(ACTIVE_WALLET_KEY);
        }
      });
    }
  }, []);

  useEffect(() => {
    if (!nodeUrl) return;
    setNodeStatus(null);
    checkNodeSync(nodeUrl, 'Node')
      .then(setNodeStatus)
      .catch(() => setNodeStatus(FAILED_STATUS(nodeUrl)));
    const interval = setInterval(() => {
      checkNodeSync(nodeUrl, 'Node')
        .then(setNodeStatus)
        .catch(() => setNodeStatus(FAILED_STATUS(nodeUrl)));
    }, 60_000);
    return () => clearInterval(interval);
  }, [nodeUrl]);

  const handleWalletReady = (w: WalletState) => {
    const newEntry: WalletEntry = {
      id: crypto.randomUUID(),
      name: `Wallet ${walletList.length + 1}`,
      mnemonic: w.mnemonic,
    };
    const next = [...walletList, newEntry];
    setWalletList(next);
    setActiveWalletId(newEntry.id);
    localStorage.setItem(WALLETS_KEY, JSON.stringify(next));
    localStorage.setItem(ACTIVE_WALLET_KEY, newEntry.id);
    setWallet(w);
    setScreen('wallet');
  };

  const handleNodeChange = (url: string) => {
    setNodeUrl(url); localStorage.setItem(NODE_KEY, url);
  };

  const handleSwitchWallet = (id: string) => {
    const entry = walletList.find(w => w.id === id);
    if (!entry) return;
    import('./lib/keys').then(({ deriveAddresses }) => {
      setWallet({ mnemonic: entry.mnemonic, addresses: deriveAddresses(entry.mnemonic, 50) });
      setActiveWalletId(id);
      localStorage.setItem(ACTIVE_WALLET_KEY, id);
      setScreen('wallet');
      setRefreshKey(k => k + 1);
    });
  };

  const handleRemoveWallet = (id: string) => {
    const next = walletList.filter(w => w.id !== id);
    if (next.length === 0) {
      localStorage.removeItem(WALLETS_KEY);
      localStorage.removeItem(ACTIVE_WALLET_KEY);
      localStorage.removeItem(NODE_KEY);
      localStorage.removeItem(ADDRESS_BOOK_KEY);
      setWalletList([]);
      setActiveWalletId(null);
      setWallet(null);
      setScreen('setup');
      setNodeStatus(null);
      setNodeUrl('');
      setAddressBook([]);
    } else {
      localStorage.setItem(WALLETS_KEY, JSON.stringify(next));
      setWalletList(next);
      if (id === activeWalletId) {
        const switchTo = next[0];
        import('./lib/keys').then(({ deriveAddresses }) => {
          setWallet({ mnemonic: switchTo.mnemonic, addresses: deriveAddresses(switchTo.mnemonic, 50) });
          setActiveWalletId(switchTo.id);
          localStorage.setItem(ACTIVE_WALLET_KEY, switchTo.id);
          setScreen('wallet');
          setRefreshKey(k => k + 1);
        });
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

  return (
    <div className="app">
      <div className="header">
        <div className="logo">
          <span style={{marginRight: 6}}>🧙‍♂️</span>Wiznerd Wallet
          {isWallet && walletList.length > 1 && activeWalletName && (
            <span style={{fontSize:11,color:'var(--text-secondary)',marginLeft:8,fontWeight:400}}>{activeWalletName}</span>
          )}
        </div>
        {isWallet && <NodeBadge status={nodeStatus}/>}
      </div>

      {screen==='setup'    && <SetupScreen onWalletReady={handleWalletReady} onCancel={isWallet ? () => setScreen('settings') : undefined}/>}
      {isWallet && screen==='wallet'   && <WalletHome wallet={wallet} nodeUrl={nodeUrl} refreshKey={refreshKey} onSendSuccess={()=>setRefreshKey(k=>k+1)} hideSmallBalances={hideSmallBalances}/>}
      {isWallet && screen==='nfts'     && <NFTsScreen/>}
      {isWallet && screen==='send'     && <SendScreen nodeUrl={nodeUrl} onSendSuccess={()=>setRefreshKey(k=>k+1)} addressBook={addressBook}/>}
      {isWallet && screen==='receive'  && <ReceiveScreen wallet={wallet}/>}
      {isWallet && screen==='history'  && <HistoryScreen/>}
      {isWallet && screen==='settings' && <SettingsScreen nodeUrl={nodeUrl} nodeStatus={nodeStatus} onNodeChange={handleNodeChange} onRemoveWallet={handleRemoveWallet} onSwitchWallet={handleSwitchWallet} onRenameWallet={handleRenameWallet} onAddWallet={() => setScreen('setup')} walletList={walletList} activeWalletId={activeWalletId} addressBook={addressBook} onAddEntry={handleAddBookEntry} onRemoveEntry={handleRemoveBookEntry} hideSmallBalances={hideSmallBalances} onToggleHideSmall={handleToggleHideSmall}/>}

      {isWallet && screen !== 'setup' && (
        <div className="bottom-nav">
          <button className={`nav-item ${screen==='wallet'?'active':''}`} onClick={()=>setScreen('wallet')}><IconHome/>Home</button>
          <button className={`nav-item ${screen==='nfts'?'active':''}`} onClick={()=>setScreen('nfts')}><IconNFTs/>NFTs</button>
          <button className={`nav-item ${screen==='send'?'active':''}`} onClick={()=>setScreen('send')}><IconSend/>Send</button>
          <button className={`nav-item ${screen==='receive'?'active':''}`} onClick={()=>setScreen('receive')}><IconReceive/>Receive</button>
          <button className={`nav-item ${screen==='history'?'active':''}`} onClick={()=>setScreen('history')}><IconHistory/>History</button>
          <button className={`nav-item ${screen==='settings'?'active':''}`} onClick={()=>setScreen('settings')}><IconSettings/>Settings</button>
        </div>
      )}
    </div>
  );
}