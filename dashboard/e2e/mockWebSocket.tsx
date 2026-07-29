import { createContext, useContext, useRef, useCallback, type ReactNode } from 'react';
import type { WSEvent } from '../src/types';

interface WSContextValue {
  connected: boolean;
  lastEvent: WSEvent | null;
  onEvent: (callback: (event: WSEvent) => void) => () => void;
}

const WSContext = createContext<WSContextValue>({
  connected: true,
  lastEvent: null,
  onEvent: () => () => {},
});

export function WSProvider({ children }: { children: ReactNode }) {
  const listenersRef = useRef<Set<(event: WSEvent) => void>>(new Set());

  (window as any).emitWSEvent = (event: WSEvent) => {
    listenersRef.current.forEach((cb) => cb(event));
  };

  const onEvent = useCallback((callback: (event: WSEvent) => void) => {
    listenersRef.current.add(callback);
    (window as any).__wsListenerCount = listenersRef.current.size;
    return () => {
      listenersRef.current.delete(callback);
      (window as any).__wsListenerCount = listenersRef.current.size;
    };
  }, []);

  return (
    <WSContext.Provider value={{ connected: true, lastEvent: null, onEvent }}>
      {children}
    </WSContext.Provider>
  );
}

export function useWS() {
  return useContext(WSContext);
}
