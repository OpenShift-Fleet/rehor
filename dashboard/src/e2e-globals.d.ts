import type { WSEvent } from './types';

declare global {
  interface Window {
    mount(scenarioId: string): void;
    unmount(): void;
    emitWSEvent?(event: WSEvent): void;
  }
}

export {};
