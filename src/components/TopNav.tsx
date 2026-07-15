import { useState, useEffect, useRef } from 'react';
import './TopNav.css';
import { useCart } from '../marketplace/CartContext';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:3002';

interface StoredWallet {
  id: string;
  name: string;
  primaryAddress?: string;
}

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link_url: string | null;
  read: boolean;
  created_at: string;
}

function shortAddr(addr: string) {
  if (!addr || addr.length < 16) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

interface TopNavProps {
  activePath?: string;
  onWalletSwitch?: (newAddress: string) => void;
  searchValue?: string;
  onSearchChange?: (v: string) => void;
  searchPlaceholder?: string;
}

const THEME_KEY = 'chia_site_theme';

export default function TopNav({ activePath, onWalletSwitch, searchValue, onSearchChange, searchPlaceholder }: TopNavProps) {
  useCart();
  const path = activePath ?? window.location.pathname;
  const [menuOpen, setMenuOpen] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [wallets, setWallets] = useState<StoredWallet[]>([]);
  const [activeWalletId, setActiveWalletId] = useState('');
  const [walletAddress, setWalletAddress] = useState('');
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [theme, setTheme] = useState<'dark'|'light'>(() => {
    try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
  });
  const menuRef   = useRef<HTMLDivElement>(null);
  const walletRef = useRef<HTMLDivElement>(null);
  const bellRef   = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch {}
  }, [theme]);

  function toggleTheme() { setTheme(t => t === 'dark' ? 'light' : 'dark'); }

  useEffect(() => {
    try {
      setWallets(JSON.parse(localStorage.getItem('chia_wallets') || '[]'));
      setActiveWalletId(localStorage.getItem('chia_active_wallet') || '');
      setWalletAddress(localStorage.getItem('chia_primary_address') || '');
    } catch {}
  }, []);

  // Poll notifications every 60 s when wallet is connected
  useEffect(() => {
    if (!walletAddress) return;
    const fetchNotifs = () => {
      fetch(`${API_URL}/api/notifications?address=${encodeURIComponent(walletAddress)}`, { signal: AbortSignal.timeout(8000) })
        .then(r => r.ok ? r.json() : [])
        .then(setNotifications)
        .catch(() => {});
    };
    fetchNotifs();
    const iv = setInterval(fetchNotifs, 60000);
    return () => clearInterval(iv);
  }, [walletAddress]);

  // Close dropdowns on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (menuRef.current   && !menuRef.current.contains(e.target as Node))   setMenuOpen(false);
      if (walletRef.current && !walletRef.current.contains(e.target as Node)) setWalletOpen(false);
      if (bellRef.current   && !bellRef.current.contains(e.target as Node))   setBellOpen(false);
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

  function markRead(id: string) {
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
    fetch(`${API_URL}/api/notifications/${id}/read`, { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(() => {});
  }

  function markAllRead() {
    if (!walletAddress) return;
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    fetch(`${API_URL}/api/notifications/read-all?address=${encodeURIComponent(walletAddress)}`, { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(() => {});
  }

  const unreadCount = notifications.filter(n => !n.read).length;
  const activeWallet = wallets.find(w => w.id === activeWalletId);

  const links = [
    { href: '/',        label: 'Wallet', match: (p: string) => p === '/' },
    { href: '/tokens',  label: 'Tokens', match: (p: string) => p.startsWith('/tokens') },
    { href: '/launch',  label: 'Launch', match: (p: string) => p.startsWith('/launch') },
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

      {/* Inline search (shown when provided by page) */}
      {onSearchChange && (
        <input
          className="wiz-nav-search"
          type="text"
          placeholder={searchPlaceholder ?? 'Search…'}
          value={searchValue ?? ''}
          onChange={e => onSearchChange(e.target.value)}
        />
      )}

      {/* Notifications bell */}
      {walletAddress && (
        <div className="wiz-bell" ref={bellRef}>
          <button
            className={`wiz-bell-btn${unreadCount > 0 ? ' has-unread' : ''}`}
            onClick={() => setBellOpen(o => !o)}
            aria-label="Notifications"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
              <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
            </svg>
            {unreadCount > 0 && (
              <span className="wiz-bell-badge">{unreadCount > 9 ? '9+' : unreadCount}</span>
            )}
          </button>

          {bellOpen && (
            <div className="wiz-notif-dropdown">
              <div className="wiz-notif-header">
                <span className="wiz-notif-title-text">Notifications</span>
                {unreadCount > 0 && (
                  <button className="wiz-notif-mark-read" onClick={markAllRead}>
                    Mark all read
                  </button>
                )}
              </div>
              {notifications.length === 0 ? (
                <div className="wiz-notif-empty">No notifications yet</div>
              ) : (
                <div className="wiz-notif-list">
                  {notifications.slice(0, 12).map(n => (
                    <a
                      key={n.id}
                      href={n.link_url || '#'}
                      className={`wiz-notif-item${!n.read ? ' unread' : ''}`}
                      onClick={() => { markRead(n.id); setBellOpen(false); }}
                    >
                      <div className="wiz-notif-item-title">{n.title}</div>
                      {n.body && <div className="wiz-notif-item-body">{n.body}</div>}
                      <div className="wiz-notif-item-time">{timeAgo(n.created_at)}</div>
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

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


      {/* Theme toggle */}
      <button className="wiz-theme-btn" onClick={toggleTheme} aria-label="Toggle theme" title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
        {theme === 'dark'
          ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
          : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        }
      </button>

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
            <div className="wiz-wallet-divider" />
            <button className="wiz-mobile-link wiz-mobile-theme" onClick={() => { toggleTheme(); setMenuOpen(false); }}>
              {theme === 'dark' ? '☀ Light mode' : '☽ Dark mode'}
            </button>
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
