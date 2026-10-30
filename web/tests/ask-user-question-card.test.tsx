// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AskUserQuestionCard,
  composeReply,
} from '../src/components/chat/AskUserQuestionCard';
import type { StepQuestion } from '../src/lib/stream-steps';
import { useShellStore } from '../src/stores/shell';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  useShellStore.setState({ composerDraftRequest: null });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const render = (questions: StepQuestion[]) =>
  act(async () => {
    root.render(<AskUserQuestionCard questions={questions} />);
  });
const button = (name: string) => {
  const found = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === name || b.getAttribute('aria-label') === name,
  );
  if (!found) throw new Error(`no button ${name}`);
  return found;
};
const click = (name: string) =>
  act(async () => {
    button(name).click();
  });
const draft = () => useShellStore.getState().composerDraftRequest;
const text = () => container.textContent ?? '';

describe('AskUserQuestionCard', () => {
  it('fills one single-choice answer on the tap, once', async () => {
    await render([
      { question: '用哪个方案？', options: ['窄 selector', '宽 selector'] },
    ]);
    await click('窄 selector');
    expect(draft()?.text).toBe('窄 selector');
    expect(button('窄 selector').getAttribute('aria-pressed')).toBe('true');
    expect(text()).toContain('已填入输入框');

    // The same answer again does not append it a second time.
    const nonce = draft()?.nonce;
    await click('窄 selector');
    expect(draft()?.nonce).toBe(nonce);

    // Another answer is filled.
    await click('宽 selector');
    expect(draft()?.text).toBe('宽 selector');
  });

  it('walks several questions one at a time and fills each answer under its question', async () => {
    await render([
      { question: '周末去哪？', options: ['爬山', '看展'] },
      {
        question: '带什么？',
        multiSelect: true,
        options: ['水', '相机', '伞'],
      },
      { question: '几点出发？', options: ['8 点', '10 点'] },
    ]);
    expect(text()).toContain('问题 1/3');
    expect(text()).toContain('周末去哪？');
    expect(text()).not.toContain('带什么？');

    // A single choice moves on by itself and fills nothing yet.
    await click('看展');
    expect(text()).toContain('问题 2/3');
    expect(text()).toContain('可多选');
    expect(draft()).toBeNull();

    // A multi-select toggles and waits.
    await click('水');
    await click('伞');
    await click('水');
    await click('相机');
    expect(text()).toContain('问题 2/3');
    expect(button('伞').getAttribute('aria-pressed')).toBe('true');
    expect(button('水').getAttribute('aria-pressed')).toBe('false');

    await click('下一题');
    await click('8 点');
    expect(text()).toContain('问题 3/3');
    expect(text()).toContain('已答 3/3');

    // Back keeps the answers.
    await click('上一题');
    expect(button('相机').getAttribute('aria-pressed')).toBe('true');

    await click('填入输入框');
    expect(draft()?.text).toBe(
      '周末去哪？\n答：看展\n带什么？\n答：伞、相机\n几点出发？\n答：8 点',
    );
    expect(text()).toContain('已填入输入框');
    expect(button('已填入').disabled).toBe(true);
  });

  it('leaves unanswered questions out and refuses to fill nothing', async () => {
    await render([
      { question: 'A？', options: ['a1', 'a2'] },
      { question: 'B？', options: ['b1'] },
    ]);
    expect(button('填入输入框').disabled).toBe(true);
    expect(button('上一题').disabled).toBe(true);
    await click('下一题');
    await click('b1');
    expect(text()).toContain('已答 1/2');
    await click('填入输入框');
    expect(draft()?.text).toBe('B？\n答：b1');
  });

  it('asks for 填入输入框 on a lone multi-select', async () => {
    await render([
      { question: '要哪些？', multiSelect: true, options: ['x', 'y'] },
    ]);
    expect(container.querySelector('[aria-label="上一题"]')).toBeNull();
    await click('x');
    await click('y');
    expect(draft()).toBeNull();
    await click('填入输入框');
    expect(draft()?.text).toBe('x、y');
  });
});

describe('composeReply', () => {
  it('gives a lone question its answers alone', () => {
    expect(composeReply([{ question: 'Q', options: [] }], [['a', 'b']])).toBe(
      'a、b',
    );
    expect(composeReply([{ question: 'Q', options: [] }], [[]])).toBe('');
  });
});
