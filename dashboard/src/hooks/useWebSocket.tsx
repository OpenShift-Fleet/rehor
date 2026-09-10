import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { WSEvent } from "../types";

interface WSContextValue {
  connected: boolean;
  lastEvent: WSEvent | null;
  onEvent: (callback: (event: WSEvent) => void) => () => void;
}

const WSContext = createContext<WSContextValue>({
  connected: false,
  lastEvent: null,
  onEvent: () => () => {},
});

export function WSProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<WSEvent | null>(null);
  const listenersRef = useRef<Set<(event: WSEvent) => void>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const connect = useCallback(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);

    ws.onclose = () => {
      setConnected(false);
      reconnectTimer.current = setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onmessage = (e) => {
      try {
        const event: WSEvent = JSON.parse(e.data);
        setLastEvent(event);
        listenersRef.current.forEach((cb) => cb(event));
      } catch {
        // ignore non-JSON messages
      }
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const onEvent = useCallback((callback: (event: WSEvent) => void) => {
    listenersRef.current.add(callback);
    return () => {
      listenersRef.current.delete(callback);
    };
  }, []);

  return (
    <WSContext.Provider value={{ connected, lastEvent, onEvent }}>{children}</WSContext.Provider>
  );
}

export function useWS() {
  return useContext(WSContext);
}
