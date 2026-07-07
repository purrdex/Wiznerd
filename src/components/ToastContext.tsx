import { createContext, useContext, useState, useCallback, useRef, ReactNode } from 'react';
import './ToastContext.css';

interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
}

interface ToastContextValue {
  showToast: (message: string, type?: Toast['type']) => void;
}

const ToastContext = createContext<ToastContextValue>({ showToast: () => {} });

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const showToast = useCallback((message: string, type: Toast['type'] = 'success') => {
    const id = ++nextId;
    setToasts(prev => [...prev.slice(-4), { id, message, type }]);
    timers.current.set(id, setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
      timers.current.delete(id);
    }, 4000));
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {toasts.length > 0 && (
        <div className="toast-stack">
          {toasts.map(t => (
            <div key={t.id} className={`toast-item toast-${t.type}`}>
              <span className="toast-icon">{t.type === 'error' ? '✕' : t.type === 'info' ? 'ℹ' : '✓'}</span>
              {t.message}
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
