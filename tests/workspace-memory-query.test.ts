import { describe, expect, test } from 'vitest';

import { memoryRecallQuery } from '../container/agent-runner/src/workspace-memory-query.js';
import { formatMessages } from '../src/message-prompt.js';
import type { NewMessage } from '../src/types.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

function message(
  id: string,
  content: string,
  extra: Partial<NewMessage> = {},
): NewMessage {
  return {
    id,
    chat_jid: 'feishu:oc_chat',
    sender: 'ou_a',
    sender_name: 'Alice',
    content,
    timestamp: '2026-10-29T08:00:00.000Z',
    ...extra,
  } as NewMessage;
}

describe('what a turn recalls memory by', () => {
  test("only the senders' own words, unescaped, without the envelope", () => {
    const text = formatMessages([
      message('m1', 'Mac mini 怎么部署 <launchd> & "pm2"?'),
      message('m2', '@"src/index.ts" 也看看', { sender_name: 'Bob' }),
    ]);
    expect(memoryRecallQuery(text)).toBe(
      'Mac mini 怎么部署 <launchd> & "pm2"?\n@"src/index.ts" 也看看',
    );
  });

  test('quoted messages and forwarded material are left out', () => {
    const text = formatMessages([
      message('m1', '这条是什么意思？', {
        channel_context: {
          message: {
            id: 'm1',
            referencedMessages: [
              { id: 'q1', sender: 'Carol', text: '引用里的发布流程' },
            ],
          },
        },
      } as Partial<NewMessage>),
      message('m2', '转发来的部署文档全文', {
        channel_context: {
          message: {
            id: 'm2',
            contentLink: {
              role: 'forwarded_content',
              bundleId: 'b1',
              defaultAction: 'summarize',
            },
          },
        },
      } as Partial<NewMessage>),
    ]);
    expect(text).toContain('引用里的发布流程');
    expect(text).toContain('default-request');
    expect(memoryRecallQuery(text)).toBe('这条是什么意思？');
  });

  test('injected history and every drained batch: the batches count, the history not', () => {
    const history =
      '<system_context>\n<history_message id="h1" role="user" sender="Alice">旧话题：数据库迁移</history_message>\n</system_context>\n\n';
    const text = `${history}${formatMessages([message('m1', '第一条')])}\n${formatMessages([message('m2', '第二条')])}`;
    expect(memoryRecallQuery(text)).toBe('第一条\n第二条');
  });

  test("a scheduled run's prompt loses the Runner's preamble", () => {
    // The preamble the Runner really writes, so rewording it fails here.
    const harness = createRuntimeSourceHarness(
      {},
      new URL('../container/agent-runner/src/index.ts', import.meta.url),
    );
    harness.install('scheduledTaskPrefixLines', 'main');
    const preamble = (
      harness.globals.scheduledTaskPrefixLines as string[]
    ).join('\n');
    expect(memoryRecallQuery(`${preamble}\n\n汇总昨天的部署记录`)).toBe(
      '汇总昨天的部署记录',
    );
    expect(memoryRecallQuery('  plain text turn  ')).toBe('plain text turn');
  });

  test('a long turn is cut to the recall budget', () => {
    expect(
      memoryRecallQuery(formatMessages([message('m1', 'x'.repeat(5000))])),
    ).toHaveLength(2000);
  });
});
