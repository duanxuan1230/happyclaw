import fs from 'node:fs';

import ts from 'typescript';
import { describe, expect, test } from 'vitest';

import {
  AgentBuilderTurnRegistry,
  agentBuilderTurnScope,
  type AgentBuilderPersistedInput,
} from '../src/agent-builder-turn-auth.js';
import {
  SKILL_MUTATION_NON_OWNER_REJECTION,
  SKILL_MUTATION_TASK_RUN_REJECTION,
  skillMutationTurnRejection,
} from '../src/skill-ipc-authorization.js';

const FOLDER = 'home-owner';
const OWNER = 'owner-1';
const GROUP_JID = 'feishu:oc_team';
const WEB_JID = `web:${FOLDER}`;

const groups: Record<string, Record<string, string>> = {
  [GROUP_JID]: {
    created_by: OWNER,
    owner_im_id: 'ou_owner',
    owner_claim_source: 'configured',
  },
  [WEB_JID]: { created_by: OWNER },
};

function check(
  messages: Record<string, AgentBuilderPersistedInput>,
  options: { isolatedTaskRun?: boolean; agentId?: string | null } = {},
) {
  const registry = new AgentBuilderTurnRegistry();
  const scope = agentBuilderTurnScope(FOLDER, options.agentId ?? null);
  const ids = Object.keys(messages);
  if (ids.length > 0) {
    registry.startBatch(
      scope,
      ids.map((messageId) => ({
        chatJid: WEB_JID,
        messageId,
        runtimeTurnId: ids[ids.length - 1],
        scheduledTaskId: null,
      })),
    );
  }
  return skillMutationTurnRejection({
    registry,
    sourceFolder: FOLDER,
    turnScope: scope,
    isolatedTaskRun: options.isolatedTaskRun ?? false,
    ownerUserId: OWNER,
    loadPersistedInput: (_chatJid, messageId) => messages[messageId] ?? null,
    getGroup: (jid) => groups[jid.split('#')[0]],
    getFolderJids: () => [GROUP_JID, WEB_JID],
    getChannelType: (jid) => (jid.startsWith('feishu:') ? 'feishu' : null),
  });
}

const input = (
  sender: string,
  sourceJid: string | null,
  extra: Partial<AgentBuilderPersistedInput> = {},
): AgentBuilderPersistedInput => ({
  content: 'install it',
  sender,
  source_jid: sourceJid,
  is_from_me: 0,
  source_kind: null,
  task_id: null,
  ...extra,
});

describe('install_skill / uninstall_skill only from the owner’s own turn', () => {
  test('the owner on the Web and in a group chat may install', () => {
    expect(check({ m1: input(OWNER, WEB_JID) })).toBeNull();
    expect(check({ m1: input('ou_owner', GROUP_JID) })).toBeNull();
    expect(
      check({ m1: input('ou_owner', GROUP_JID) }, { agentId: 'session-a' }),
    ).toBeNull();
  });

  test('a group member’s turn is refused with a clear reason', () => {
    expect(check({ m1: input('ou_member', GROUP_JID) })).toBe(
      SKILL_MUTATION_NON_OWNER_REJECTION,
    );
    // An owner message batched with a member's message does not lend authority.
    expect(
      check({
        m1: input('ou_owner', GROUP_JID),
        m2: input('ou_member', GROUP_JID),
      }),
    ).toBe(SKILL_MUTATION_NON_OWNER_REJECTION);
    expect(SKILL_MUTATION_NON_OWNER_REJECTION).toContain('工作区主人');
  });

  test('an owner claimed only by /owner_mention is not trusted', () => {
    groups['feishu:oc_claimed'] = {
      created_by: OWNER,
      owner_im_id: 'ou_claimer',
      owner_claim_source: 'explicit',
    };
    expect(check({ m1: input('ou_claimer', 'feishu:oc_claimed') })).toBe(
      SKILL_MUTATION_NON_OWNER_REJECTION,
    );
  });

  test('scheduled, isolated-task and turn-less requests are refused', () => {
    expect(
      check({
        m1: input(OWNER, WEB_JID, {
          task_id: 'task-1',
          source_kind: 'scheduled_task_prompt',
        }),
      }),
    ).toBe(SKILL_MUTATION_NON_OWNER_REJECTION);
    expect(check({}, { isolatedTaskRun: true })).toBe(
      SKILL_MUTATION_TASK_RUN_REJECTION,
    );
    expect(check({})).toBe(SKILL_MUTATION_NON_OWNER_REJECTION);
  });

  test('both IPC handlers check the turn before touching the Skill set', () => {
    const source = fs.readFileSync('src/index.ts', 'utf8');
    const file = ts.createSourceFile(
      'index.ts',
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const clauses: Record<string, string> = {};
    const visit = (node: ts.Node): void => {
      if (
        ts.isCaseClause(node) &&
        ts.isStringLiteral(node.expression) &&
        ['install_skill', 'uninstall_skill'].includes(node.expression.text)
      ) {
        clauses[node.expression.text] = node.getText(file);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    for (const [name, mutate] of [
      ['install_skill', 'installSkillForUser('],
      ['uninstall_skill', 'deleteSkillForUser('],
    ]) {
      const body = clauses[name];
      expect(body).toBeDefined();
      const guard = body.indexOf('skillMutationTurnRejectionFor(');
      expect(guard).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(body.indexOf(mutate));
    }
  });
});
