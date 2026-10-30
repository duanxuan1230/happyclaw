// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { useLongPress } from './useLongPress';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

function Row({
  onLongPress,
  onClick,
}: {
  onLongPress: () => void;
  onClick: () => void;
}) {
  const press = useLongPress(onLongPress, { ms: 400 });
  return (
    <button type="button" data-row onClick={onClick} {...press}>
      row
    </button>
  );
}

function render() {
  vi.useFakeTimers();
  const onLongPress = vi.fn();
  const onClick = vi.fn();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  act(() => root!.render(<Row onLongPress={onLongPress} onClick={onClick} />));
  const row = container.querySelector<HTMLElement>('[data-row]')!;
  const fire = (type: string, init: PointerEventInit = {}) =>
    act(() => {
      row.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerId: 1,
          pointerType: 'touch',
          isPrimary: true,
          clientX: 10,
          clientY: 10,
          ...init,
        }),
      );
    });
  const contextMenu = () => {
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      row.dispatchEvent(event);
    });
    return event;
  };
  const click = () => act(() => row.click());
  return { row, fire, contextMenu, click, onLongPress, onClick };
}

describe('useLongPress', () => {
  test('a held finger fires once the delay passes', () => {
    const { fire, onLongPress } = render();
    fire('pointerdown');
    act(() => vi.advanceTimersByTime(399));
    expect(onLongPress).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  test('a short tap is a plain click', () => {
    const { fire, click, onLongPress, onClick } = render();
    fire('pointerdown');
    act(() => vi.advanceTimersByTime(200));
    fire('pointerup');
    click();
    act(() => vi.advanceTimersByTime(500));
    expect(onLongPress).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test('moving more than 8px calls it off; less does not', () => {
    const first = render();
    first.fire('pointerdown');
    first.fire('pointermove', { clientX: 15, clientY: 15 });
    act(() => vi.advanceTimersByTime(400));
    expect(first.onLongPress).toHaveBeenCalledTimes(1);
    act(() => root?.unmount());
    root = null;

    const second = render();
    second.fire('pointerdown');
    second.fire('pointermove', { clientX: 10, clientY: 19 });
    act(() => vi.advanceTimersByTime(400));
    expect(second.onLongPress).not.toHaveBeenCalled();
  });

  test('a cancelled pointer (the page scrolled) calls it off', () => {
    const { fire, onLongPress } = render();
    fire('pointerdown');
    fire('pointercancel');
    act(() => vi.advanceTimersByTime(400));
    expect(onLongPress).not.toHaveBeenCalled();
  });

  test('the click after a long press is swallowed, the next one is not', () => {
    const { fire, click, onClick } = render();
    fire('pointerdown');
    act(() => vi.advanceTimersByTime(400));
    fire('pointerup');
    click();
    expect(onClick).not.toHaveBeenCalled();
    click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test('a touch press blocks the native context menu and callout', () => {
    const { row, fire, contextMenu } = render();
    fire('pointerdown');
    expect(contextMenu().defaultPrevented).toBe(true);
    expect(row.style.getPropertyValue('-webkit-touch-callout')).toBe('none');
  });

  test('a mouse neither long-presses nor loses its right click', () => {
    const { fire, contextMenu, onLongPress } = render();
    fire('pointerdown', { pointerType: 'mouse' });
    act(() => vi.advanceTimersByTime(1000));
    expect(onLongPress).not.toHaveBeenCalled();
    expect(contextMenu().defaultPrevented).toBe(false);
  });
});
