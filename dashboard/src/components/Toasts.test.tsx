import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WSEvent } from '../types';
import Toasts from './Toasts';

let eventHandler: ((event: WSEvent) => void) | null = null;

vi.mock('../hooks/useWebSocket', () => ({
  useWS: () => ({
    connected: true,
    lastEvent: null,
    onEvent: (cb: (event: WSEvent) => void) => {
      eventHandler = cb;
      return () => { eventHandler = null; };
    },
  }),
}));

function emitEvent(event: WSEvent) {
  act(() => {
    eventHandler?.(event);
  });
}

beforeEach(() => {
  eventHandler = null;
});

describe('Toasts', () => {
  it('renders nothing when no events', () => {
    const { container } = render(<Toasts />);
    expect(container.firstChild).toBeNull();
  });

  it('renders toast for task_added event', () => {
    render(<Toasts />);
    emitEvent({
      type: 'task_added',
      data: { external_key: 'RHCLOUD-100', summary: 'New task' },
      timestamp: Date.now(),
    });
    expect(screen.getByText('Task added')).toBeInTheDocument();
    expect(screen.getByText('RHCLOUD-100')).toBeInTheDocument();
    expect(screen.getByText('New task')).toBeInTheDocument();
  });

  it('renders toast for task_updated event', () => {
    render(<Toasts />);
    emitEvent({
      type: 'task_updated',
      data: { external_key: 'RHCLOUD-200', status: 'in_progress' },
      timestamp: Date.now(),
    });
    expect(screen.getByText('Task updated')).toBeInTheDocument();
    expect(screen.getByText('RHCLOUD-200')).toBeInTheDocument();
    expect(screen.getByText('in_progress')).toBeInTheDocument();
  });

  it('renders toast for memory_stored event', () => {
    render(<Toasts />);
    emitEvent({
      type: 'memory_stored',
      data: { id: 42, category: 'pattern' },
      timestamp: Date.now(),
    });
    expect(screen.getByText('Memory stored')).toBeInTheDocument();
    expect(screen.getByText('#42')).toBeInTheDocument();
    expect(screen.getByText('pattern')).toBeInTheDocument();
  });

  it('ignores bot_status events', () => {
    const { container } = render(<Toasts />);
    emitEvent({
      type: 'bot_status',
      data: { state: 'working' },
      timestamp: Date.now(),
    });
    expect(container.firstChild).toBeNull();
  });

  it('dismisses toast on close button click', () => {
    render(<Toasts />);
    emitEvent({
      type: 'task_archived',
      data: { external_key: 'RHCLOUD-300' },
      timestamp: Date.now(),
    });
    expect(screen.getByText('Task archived')).toBeInTheDocument();
    fireEvent.click(screen.getByText('X'));
    expect(screen.queryByText('Task archived')).toBeNull();
  });

  it('auto-dismisses toast after 8 seconds', () => {
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
    render(<Toasts />);
    emitEvent({
      type: 'task_removed',
      data: { external_key: 'RHCLOUD-400' },
      timestamp: Date.now(),
    });
    expect(screen.getByText('Task removed')).toBeInTheDocument();
    const timerCallback = setTimeoutSpy.mock.calls.find((call) => call[1] === 8000)?.[0] as () => void;
    expect(timerCallback).toBeDefined();
    act(() => {
      timerCallback();
    });
    expect(screen.queryByText('Task removed')).toBeNull();
    setTimeoutSpy.mockRestore();
  });
});
