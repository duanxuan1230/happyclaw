import { replaceInApp, withBasePath } from '../utils/url';

type WsHandler = (data: any) => void;

/** A handshake still pending after this long is abandoned and retried. */
export const WS_HANDSHAKE_TIMEOUT_MS = 15_000;
/**
 * Back in the foreground, an open socket that has received nothing for this
 * long is presumed dead. Mobile browsers freeze background pages and often
 * never deliver the close of a socket the server or network dropped, and the
 * server's heartbeat pings are invisible to page JS, so silence is the only
 * signal. Replacing a healthy socket costs one reconnect sync.
 */
export const WS_FOREGROUND_STALE_MS = 30_000;

class WsManager {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<WsHandler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  /** Whether a socket of this page has opened before (later opens are reconnects). */
  private openedBefore = false;
  private failedBeforeOpen = false;
  /** connect() was called and disconnect() has not been since. */
  private wanted = false;
  /** Last open or received message on the current socket. */
  private lastActivityAt = 0;

  connect() {
    this.wanted = true;
    if (
      this.ws?.readyState === WebSocket.OPEN ||
      this.ws?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }
    this.clearReconnectTimer();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(
      `${protocol}//${window.location.host}${withBasePath('/ws')}`,
    );
    this.ws = ws;
    this.clearHandshakeTimer();
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (this.ws === ws && ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }, WS_HANDSHAKE_TIMEOUT_MS);

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.clearHandshakeTimer();
      this.reconnectDelay = 1000;
      this.lastActivityAt = Date.now();
      // Listeners reconcile state missed while the socket was down; the
      // page's first open follows the initial HTTP loads, so it says so.
      // A failed attempt before the first open (e.g. the server was
      // restarting during page load) means events may already be missing.
      const reconnect = this.openedBefore || this.failedBeforeOpen;
      this.openedBefore = true;
      this.emit('connected', { reconnect });
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      this.lastActivityAt = Date.now();
      let data: any;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      this.emit(data.type, data);
    };

    ws.onclose = (event: CloseEvent) => {
      if (this.ws !== ws) return;
      this.clearHandshakeTimer();
      if (!this.openedBefore) this.failedBeforeOpen = true;
      this.emit('disconnected', {});
      // 1008 = Policy Violation (backend auth failure), 4001 = custom auth error
      if (event.code === 1008 || event.code === 4001) {
        this.ws = null;
        this.wanted = false;
        replaceInApp('/login');
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      ws.close();
    };
  }

  disconnect() {
    this.wanted = false;
    this.clearReconnectTimer();
    this.dropSocket();
  }

  isConnected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(data: object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
      return true;
    }
    return false;
  }

  on(type: string, handler: WsHandler) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }

  private emit(type: string, data: any) {
    this.handlers.get(type)?.forEach((h) => {
      // One failing listener must not starve the others of the event.
      try {
        h(data);
      } catch (err) {
        console.error(`[ws] "${type}" handler failed`, err);
      }
    });
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearHandshakeTimer() {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  /** Forget the current socket without treating its close as a disconnect. */
  private dropSocket() {
    this.clearHandshakeTimer();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    // ±30% jitter so tabs dropped together (e.g. a server restart) don't
    // all reconnect and refetch in the same second.
    const jitter = 0.7 + Math.random() * 0.6;
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = null;
        this.reconnectDelay = Math.min(
          this.reconnectDelay * 2,
          this.maxReconnectDelay,
        );
        this.connect();
      },
      Math.round(this.reconnectDelay * jitter),
    );
  }

  /**
   * Reconnect now unless the socket is open and recently heard from. A
   * replaced socket's close is ignored; the new socket's open reports
   * `reconnect: true`, which runs the usual missed-state sync.
   */
  private ensureLive() {
    if (!this.wanted) return;
    if (
      this.ws?.readyState === WebSocket.OPEN &&
      Date.now() - this.lastActivityAt < WS_FOREGROUND_STALE_MS
    ) {
      return;
    }
    if (this.ws && !this.openedBefore) this.failedBeforeOpen = true;
    this.clearReconnectTimer();
    this.reconnectDelay = 1000;
    this.dropSocket();
    this.connect();
  }

  /** Watch page lifecycle and network changes to recover a lost connection. */
  setupNetworkListeners() {
    // Network restored or page back in front: the socket may have died
    // unnoticed, and any pending backoff is no longer worth waiting out.
    // Going offline leaves the backoff running; nothing ever cancels it.
    window.addEventListener('online', () => this.ensureLive());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.ensureLive();
    });
    // A page kept in the back/forward cache resumes with a socket that
    // closed while it was frozen.
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) this.ensureLive();
    });
  }
}

export const wsManager = new WsManager();
// Stores import the manager (auth disconnects on logout), and their unit
// tests load it outside a browser.
if (typeof window !== 'undefined') wsManager.setupNetworkListeners();
