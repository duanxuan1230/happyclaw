// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  measureVisualViewport,
  useKeyboardInset,
  useVisualViewportVars,
} from './useVisualViewport';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class FakeVisualViewport extends EventTarget {
  height = window.innerHeight;
  offsetTop = 0;
  scale = 1;
}

let viewport: FakeVisualViewport;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let inset: number | null = null;
const originalViewport = Object.getOwnPropertyDescriptor(
  window,
  'visualViewport',
);

function Vars() {
  useVisualViewportVars();
  return null;
}

function Inset() {
  inset = useKeyboardInset();
  return null;
}

const cssVar = (name: string) =>
  document.documentElement.style.getPropertyValue(name);

async function move(next: Partial<FakeVisualViewport>, type = 'resize') {
  await act(async () => {
    Object.assign(viewport, next);
    viewport.dispatchEvent(new Event(type));
  });
}

beforeEach(() => {
  viewport = new FakeVisualViewport();
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: viewport,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  inset = null;
  if (originalViewport) {
    Object.defineProperty(window, 'visualViewport', originalViewport);
  }
});

describe('measureVisualViewport', () => {
  const vv = (height: number, offsetTop = 0, scale = 1) => ({
    height,
    offsetTop,
    scale,
  });

  test('counts only what the keyboard still covers after the iOS pan', () => {
    expect(measureVisualViewport(844, vv(500))).toEqual({
      height: 500,
      keyboardInset: 344,
    });
    // iOS panned the page up 100px: 100px of the gap is page, not keyboard.
    expect(measureVisualViewport(844, vv(500, 100))).toEqual({
      height: 500,
      keyboardInset: 244,
    });
  });

  test('reports no keyboard while pinch-zoomed and keeps the layout height', () => {
    expect(measureVisualViewport(844, vv(422, 200, 2))).toEqual({
      height: 844,
      keyboardInset: 0,
    });
  });

  test('treats gaps under 50px as browser chrome', () => {
    expect(measureVisualViewport(844, vv(795)).keyboardInset).toBe(0);
    expect(measureVisualViewport(844, vv(794)).keyboardInset).toBe(50);
    expect(measureVisualViewport(844, vv(500, 300)).keyboardInset).toBe(0);
  });

  test('falls back to the layout viewport without visualViewport', () => {
    expect(measureVisualViewport(700, null)).toEqual({
      height: 700,
      keyboardInset: 0,
    });
  });
});

describe('useVisualViewportVars', () => {
  test('publishes --vvh and --keyboard-inset and follows the viewport', async () => {
    const h = window.innerHeight;
    await act(async () => root?.render(<Vars />));
    expect(cssVar('--vvh')).toBe(`${h}px`);
    expect(cssVar('--keyboard-inset')).toBe('0px');

    await move({ height: h - 300 });
    expect(cssVar('--vvh')).toBe(`${h - 300}px`);
    expect(cssVar('--keyboard-inset')).toBe('300px');

    // The iOS pan arrives as a visualViewport scroll, not a resize.
    await move({ offsetTop: 120 }, 'scroll');
    expect(cssVar('--keyboard-inset')).toBe('180px');

    await act(async () => root?.unmount());
    root = null;
    expect(cssVar('--vvh')).toBe('');
    expect(cssVar('--keyboard-inset')).toBe('');
  });

  test('shares one set of listeners between all subscribers', async () => {
    const add = vi.spyOn(viewport, 'addEventListener');
    const remove = vi.spyOn(viewport, 'removeEventListener');
    await act(async () =>
      root?.render(
        <>
          <Vars />
          <Inset />
          <Inset />
        </>,
      ),
    );
    expect(add.mock.calls.map(([type]) => type).sort()).toEqual([
      'resize',
      'scroll',
    ]);

    await move({ height: window.innerHeight - 260 });
    expect(inset).toBe(260);

    await act(async () => root?.unmount());
    root = null;
    expect(remove).toHaveBeenCalledTimes(2);
  });
});

describe('useKeyboardInset', () => {
  test('reads a keyboard that is already up when it mounts', async () => {
    viewport.height = window.innerHeight - 280;
    await act(async () => root?.render(<Inset />));
    expect(inset).toBe(280);

    await move({ height: window.innerHeight / 2, scale: 2 });
    expect(inset).toBe(0);
  });
});
