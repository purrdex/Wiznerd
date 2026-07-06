import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';

export interface CartItem {
  offer_id: string;
  nft_id: string;
  nft_name: string;
  image_url: string | null;
  price_mojo: number;
  price_token: string;
  collection_id: string;
  collection_name?: string;
}

interface CartContextValue {
  items: CartItem[];
  addItem: (item: CartItem) => void;
  removeItem: (offer_id: string) => void;
  clearCart: () => void;
  hasItem: (offer_id: string) => boolean;
}

const CartContext = createContext<CartContextValue>({
  items: [], addItem: () => {}, removeItem: () => {}, clearCart: () => {}, hasItem: () => false,
});

const STORAGE_KEY = 'mp_cart';

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<CartItem[]>(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
  });

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); } catch {}
    window.dispatchEvent(new CustomEvent('mp-cart-update', { detail: items.length }));
  }, [items]);

  const addItem = useCallback((item: CartItem) => {
    setItems(prev => prev.some(i => i.offer_id === item.offer_id) ? prev : [...prev, item]);
  }, []);

  const removeItem = useCallback((offer_id: string) => {
    setItems(prev => prev.filter(i => i.offer_id !== offer_id));
  }, []);

  const clearCart = useCallback(() => setItems([]), []);
  const hasItem = useCallback((offer_id: string) => items.some(i => i.offer_id === offer_id), [items]);

  return (
    <CartContext.Provider value={{ items, addItem, removeItem, clearCart, hasItem }}>
      {children}
    </CartContext.Provider>
  );
}

export function useCart() { return useContext(CartContext); }
