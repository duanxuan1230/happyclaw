import { useEffect, useSyncExternalStore } from 'react';

// A visual viewport this much shorter than the layout viewport is a software
// keyboard; smaller gaps are rounding or browser chrome.
const KEYBOARD_MIN_HEIGHT_PX = 50;

export interface VisualViewportMetrics {
  /** Visible height in CSS px (the layout height while pinch-zoomed). */
  height: number;
  /** Layout-viewport pixels covered at the bottom by the software keyboard. */
  keyboardInset: number;
}

type ViewportLike = Pick<VisualViewport, 'height' | 'offsetTop' | 'scale'>;

/**
 * The single source for keyboard occlusion. iOS pans the visual viewport up
 * (offsetTop) when it focuses a low field; that pan already brings part of
 * the page into view, so only what is still covered counts. Pinch-zoom also
 * shrinks the visual viewport, and lifting UI by the zoomed-away height would
 * push it off screen, so zoom reports no keyboard and keeps the layout height.
 */
export function measureVisualViewport(
  innerHeight: number,
  viewport: ViewportLike | null | undefined,
): VisualViewportMetrics {
  if (!viewport || viewport.scale > 1.01) {
    return { height: Math.round(innerHeight), keyboardInset: 0 };
  }
  const covered = innerHeight - viewport.height - viewport.offsetTop;
  return {
    height: Math.round(viewport.height),
    keyboardInset: covered >= KEYBOARD_MIN_HEIGHT_PX ? Math.round(covered) : 0,
  };
}

const listeners = new Set<() => void>();
let snapshot: VisualViewportMetrics = { height: 0, keyboardInset: 0 };
let detach: (() => void) | null = null;

function read(): VisualViewportMetrics {
  return measureVisualViewport(window.innerHeight, window.visualViewport);
}

function update() {
  const next = read();
  if (
    next.height === snapshot.height &&
    next.keyboardInset === snapshot.keyboardInset
  ) {
    return;
  }
  snapshot = next;
  listeners.forEach((listener) => listener());
}

// One set of window listeners however many components subscribe; attached
// with the first subscriber and dropped with the last.
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!detach) {
    snapshot = read();
    const viewport = window.visualViewport;
    // vv 'scroll' carries the offsetTop pan; window 'resize' covers browsers
    // without visualViewport and the Android resizes-content case.
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    detach = () => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && detach) {
      detach();
      detach = null;
    }
  };
}

function getSnapshot(): VisualViewportMetrics {
  // Before anything subscribes there is no listener keeping the cache fresh.
  if (!detach && typeof window !== 'undefined') snapshot = read();
  return snapshot;
}

export function useKeyboardInset(): number {
  return useSyncExternalStore(
    subscribe,
    () => getSnapshot().keyboardInset,
    () => 0,
  );
}

/**
 * Publishes `--vvh` and `--keyboard-inset` on <html>. Mount once, from the
 * app shell; CSS everywhere reads the variables instead of measuring.
 */
export function useVisualViewportVars(): void {
  useEffect(() => {
    const root = document.documentElement;
    // Root custom properties restyle the whole page; during the keyboard
    // animation only one of the two usually moves, so skip the other.
    const set = (name: string, px: number) => {
      const value = `${px}px`;
      if (root.style.getPropertyValue(name) !== value) {
        root.style.setProperty(name, value);
      }
    };
    const publish = () => {
      set('--vvh', snapshot.height);
      set('--keyboard-inset', snapshot.keyboardInset);
    };
    const unsubscribe = subscribe(publish);
    publish();
    return () => {
      unsubscribe();
      root.style.removeProperty('--vvh');
      root.style.removeProperty('--keyboard-inset');
    };
  }, []);
}
