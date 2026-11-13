import { useCallback, useEffect, useRef } from "react";

/**
 * Trailing debounce with a stable identity: rapid calls coalesce into a single
 * invocation of the latest callback once `delayMs` has elapsed without a new
 * call. Any pending invocation is cancelled when the component unmounts.
 */
export function useDebouncedCallback<Args extends unknown[]>(
  callback: (...args: Args) => void,
  delayMs: number,
): (...args: Args) => void {
  const callbackRef = useRef(callback);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    };
  }, []);

  return useCallback(
    (...args: Args) => {
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = undefined;
        callbackRef.current(...args);
      }, delayMs);
    },
    [delayMs],
  );
}
