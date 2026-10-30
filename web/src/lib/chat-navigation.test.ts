// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest';

import { goBackGuarded, hasAppEntryBefore } from './chat-navigation';

afterEach(() => {
  window.history.replaceState(null, '');
});

describe('goBackGuarded', () => {
  test('steps back when the router has an entry before this one', () => {
    window.history.replaceState({ idx: 2, key: 'k', usr: null }, '');
    const navigate = vi.fn();
    expect(hasAppEntryBefore()).toBe(true);
    goBackGuarded(navigate, '/chat');
    expect(navigate).toHaveBeenCalledWith(-1);
  });

  test('replaces the first entry (a deep link) with the fallback', () => {
    window.history.replaceState({ idx: 0, key: 'k', usr: null }, '');
    const navigate = vi.fn();
    goBackGuarded(navigate, '/chat');
    expect(navigate).toHaveBeenCalledWith('/chat', { replace: true });
  });

  test('replaces when the history is not the router’s (a memory router)', () => {
    const navigate = vi.fn();
    expect(hasAppEntryBefore()).toBe(false);
    goBackGuarded(navigate, '/chat');
    expect(navigate).toHaveBeenCalledWith('/chat', { replace: true });
  });
});
