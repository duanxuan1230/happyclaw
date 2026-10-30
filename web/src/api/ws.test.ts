// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closeCalls = 0;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  receive(data: object) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  close() {
    this.closeCalls++;
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code: 1006 });
  }

  send() {}
}

type Manager = (typeof import('./ws'))['wsManager'];
type Ws = typeof import('./ws');
let ws: Ws;
let manager: Manager;

const sockets = () => FakeSocket.instances;
const latest = () => sockets()[sockets().length - 1];

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeSocket);
  FakeSocket.instances = [];
  // A fresh manager per test; each import installs its own listeners.
  vi.resetModules();
  ws = await import('./ws');
  manager = ws.wsManager;
});

afterEach(() => {
  manager.disconnect();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('wsManager', () => {
  test('abandons a handshake that never completes and retries', () => {
    manager.connect();
    const first = latest();
    vi.advanceTimersByTime(ws.WS_HANDSHAKE_TIMEOUT_MS - 1);
    expect(first.closeCalls).toBe(0);

    vi.advanceTimersByTime(1);
    expect(first.closeCalls).toBe(1);
    // Retry follows the usual backoff (1s ±30%).
    vi.advanceTimersByTime(1300);
    expect(sockets()).toHaveLength(2);
  });

  test('a handshake that completes in time is kept', () => {
    manager.connect();
    latest().open();
    vi.advanceTimersByTime(ws.WS_HANDSHAKE_TIMEOUT_MS * 2);
    expect(sockets()).toHaveLength(1);
    expect(latest().closeCalls).toBe(0);
  });

  test('going offline does not cancel the pending reconnect', () => {
    manager.connect();
    latest().open();
    latest().close();
    window.dispatchEvent(new Event('offline'));
    vi.advanceTimersByTime(1300);
    expect(sockets()).toHaveLength(2);
  });

  test('coming online reconnects at once instead of waiting out the backoff', () => {
    manager.connect();
    latest().close();
    expect(sockets()).toHaveLength(1);
    window.dispatchEvent(new Event('online'));
    expect(sockets()).toHaveLength(2);
  });

  test('back in the foreground, a silent open socket is replaced and resynced', () => {
    const connected = vi.fn();
    const disconnected = vi.fn();
    manager.on('connected', connected);
    manager.on('disconnected', disconnected);
    manager.connect();
    const stale = latest();
    stale.open();
    expect(connected).toHaveBeenLastCalledWith({ reconnect: false });

    setVisibility('hidden');
    vi.advanceTimersByTime(ws.WS_FOREGROUND_STALE_MS);
    setVisibility('visible');

    expect(stale.closeCalls).toBe(1);
    expect(sockets()).toHaveLength(2);
    // The replaced socket's close is not reported as an outage.
    expect(disconnected).not.toHaveBeenCalled();
    latest().open();
    expect(connected).toHaveBeenLastCalledWith({ reconnect: true });
  });

  test('back in the foreground, a socket that heard from the server recently is kept', () => {
    manager.connect();
    latest().open();
    vi.advanceTimersByTime(ws.WS_FOREGROUND_STALE_MS - 1000);
    latest().receive({ type: 'billing_update' });
    vi.advanceTimersByTime(1000);
    setVisibility('visible');
    expect(sockets()).toHaveLength(1);
  });

  test('back in the foreground, a closed socket reconnects without waiting', () => {
    manager.connect();
    latest().open();
    latest().close();
    setVisibility('visible');
    expect(sockets()).toHaveLength(2);
  });

  test('a page restored from the back/forward cache reconnects', () => {
    manager.connect();
    latest().open();
    vi.advanceTimersByTime(ws.WS_FOREGROUND_STALE_MS);
    const restored = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(restored, 'persisted', { value: true });
    window.dispatchEvent(restored);
    expect(sockets()).toHaveLength(2);
    latest().open();

    const firstLoad = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(firstLoad, 'persisted', { value: false });
    vi.advanceTimersByTime(ws.WS_FOREGROUND_STALE_MS);
    window.dispatchEvent(firstLoad);
    expect(sockets()).toHaveLength(2);
  });

  test('stays down after disconnect() even when the page returns', () => {
    manager.connect();
    latest().open();
    manager.disconnect();
    setVisibility('visible');
    window.dispatchEvent(new Event('online'));
    expect(sockets()).toHaveLength(1);
  });

  test('a throwing handler does not stop the others', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const after = vi.fn();
    manager.on('task_notification', () => {
      throw new Error('boom');
    });
    manager.on('task_notification', after);
    manager.connect();
    latest().open();
    latest().receive({ type: 'task_notification', id: 1 });
    expect(after).toHaveBeenCalledWith({ type: 'task_notification', id: 1 });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
