import { useState, useEffect, useRef } from 'react';
import './TopNav.css';

interface StoredWallet {
  id: string;
  name: string;
  primaryAddress?: string;
}

function shortAddr(addr: string) {
  if (!addr || addr.length < 16) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

interface TopNavProps {
  /** Override active link detection (defaults to window.location.pathname) */
  activePath?: string;
  /** Called when wallet is switched from the dropdown — lets page reload its data */
  onWalletSwitch?: (newAddress: string) => void;
}

export default function TopNav({ activePath, onWalletSwitch }: TopNavProps) {
  const path = activePath ?? window.location.pathname;
  const [menuOpen, setMenuOpen] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const [wallets, setWallets] = useState<StoredWallet[]>([]);
  const [activeWalletId, setActiveWalletId] = useState('');
  const [walletAddress, setWalletAddress] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const walletRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      setWallets(JSON.parse(localStorage.getItem('chia_wallets') || '[]'));
      setActiveWalletId(localStorage.getItem('chia_active_wallet') || '');
      setWalletAddress(localStorage.getItem('chia_primary_address') || '');
    } catch {}
  }, []);

  // Close dropdowns on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
      if (walletRef.current && !walletRef.current.contains(e.target as Node)) setWalletOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  function switchWallet(w: StoredWallet) {
    setWalletOpen(false);
    if (w.id === activeWalletId) return;
    if (!w.primaryAddress) {
      localStorage.setItem('chia_active_wallet', w.id);
      sessionStorage.setItem('chia_return_url', window.location.pathname);
      window.location.href = '/';
      return;
    }
    localStorage.setItem('chia_active_wallet', w.id);
    localStorage.setItem('chia_primary_address', w.primaryAddress);
    setActiveWalletId(w.id);
    setWalletAddress(w.primaryAddress);
    onWalletSwitch?.(w.primaryAddress);
  }

  const activeWallet = wallets.find(w => w.id === activeWalletId);

  const links = [
    { href: '/',                    label: 'Wallet',      match: (p: string) => p === '/' },
    { href: '/marketplace',         label: 'Marketplace', match: (p: string) => p === '/marketplace' },
    { href: '/marketplace/offers',  label: 'Offer Board', match: (p: string) => p === '/marketplace/offers' },
    { href: '/create',              label: 'Create',      match: (p: string) => p.startsWith('/create') },
    { href: '/marketplace/profile', label: 'My NFTs',     match: (p: string) => p === '/marketplace/profile' },
  ];

  return (
    <nav className="wiz-nav">
      {/* Brand */}
      <a href="/" className="wiz-brand">
        <img src="/tepe.png" alt="Wiznerd" className="wiz-brand-avatar" />
        <span className="wiz-brand-name">Wiznerd<span className="wiz-brand-dot">.</span></span>
      </a>

      {/* Desktop links */}
      <div className="wiz-links">
        {links.map(l => (
          <a
            key={l.href}
            href={l.href}
            className={`wiz-link${l.match(path) ? ' active' : ''}`}
          >
            {l.label}
          </a>
        ))}
      </div>

      {/* Wallet switcher (desktop) */}
      {wallets.length > 0 && (
        <div className="wiz-wallet-switcher" ref={walletRef}>
          <button className="wiz-wallet-btn" onClick={() => setWalletOpen(o => !o)}>
            <span className="wiz-wallet-dot" />
            <span className="wiz-wallet-name">{activeWallet?.name || 'Wallet'}</span>
            {walletAddress && <span className="wiz-wallet-addr">{shortAddr(walletAddress)}</span>}
            <span className="wiz-wallet-caret">{walletOpen ? '▲' : '▼'}</span>
          </button>

          {walletOpen && (
            <div className="wiz-wallet-dropdown">
              {wallets.map(w => (
                <button
                  key={w.id}
                  className={`wiz-wallet-item${w.id === activeWalletId ? ' active' : ''}`}
                  onClick={() => switchWallet(w)}
                >
                  <div>
                    <div className="wiz-wallet-item-name">{w.name}</div>
                    {w.primaryAddress && (
                      <div className="wiz-wallet-item-addr">{shortAddr(w.primaryAddress)}</div>
                    )}
                  </div>
                  {w.id === activeWalletId
                    ? <span className="wiz-wallet-check">✓</span>
                    : !w.primaryAddress && <span className="wiz-wallet-locked">🔒</span>
                  }
                </button>
              ))}
              <div className="wiz-wallet-divider" />
              <button className="wiz-wallet-item" onClick={() => { setWalletOpen(false); window.location.href = '/'; }}>
                Manage wallets →
              </button>
            </div>
          )}
        </div>
      )}

      {/* Mobile hamburger */}
      <div className="wiz-hamburger" ref={menuRef}>
        <button
          className={`wiz-hamburger-btn${menuOpen ? ' open' : ''}`}
          onClick={() => setMenuOpen(o => !o)}
          aria-label="Menu"
        >
          <span /><span /><span />
        </button>

        {menuOpen && (
          <div className="wiz-mobile-menu">
            {links.map(l => (
              <a
                key={l.href}
                href={l.href}
                className={`wiz-mobile-link${l.match(path) ? ' active' : ''}`}
                onClick={() => setMenuOpen(false)}
              >
                {l.label}
              </a>
            ))}
            {wallets.length > 0 && (
              <>
                <div className="wiz-wallet-divider" />
                {wallets.map(w => (
                  <button
                    key={w.id}
                    className={`wiz-mobile-link wiz-wallet-row${w.id === activeWalletId ? ' active' : ''}`}
                    onClick={() => { setMenuOpen(false); switchWallet(w); }}
                  >
                    <span>{w.name}</span>
                    {w.id === activeWalletId && <span style={{ color: '#f97316' }}>✓</span>}
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </nav>
  );
}
