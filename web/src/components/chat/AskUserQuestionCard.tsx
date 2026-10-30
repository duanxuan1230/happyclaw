import { useState, type ReactNode } from 'react';
import { Check, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { StepQuestion } from '../../lib/stream-steps';
import { useShellStore } from '../../stores/shell';

/**
 * AskUserQuestion options. The runner has no interactive answer channel, so
 * the reply is the user's next message: the card collects the answers and
 * fills them into the composer for the user to edit and send.
 *
 * - One single-choice question: a tap fills the composer right away.
 * - Several questions: one at a time; a single choice moves on by itself,
 *   a multi-select waits for 下一题. 填入输入框 writes every answer, each
 *   under its question, so the reply says which answer is for what.
 */
export function AskUserQuestionCard({
  questions,
}: {
  questions: readonly StepQuestion[];
}) {
  const [answers, setAnswers] = useState<string[][]>(() =>
    questions.map(() => []),
  );
  const [index, setIndex] = useState(0);
  const [filled, setFilled] = useState<string | null>(null);

  if (questions.length === 0) return null;
  const total = questions.length;
  const at = Math.min(index, total - 1);
  const q = questions[at];
  const chosen = answers[at] ?? [];
  const quick = total === 1 && !q.multiSelect;
  const reply = composeReply(questions, answers);
  const answered = answers.filter((a) => a.length > 0).length;

  const fill = (text: string) => {
    if (!text || text === filled) return;
    useShellStore.getState().requestComposerDraft(text);
    setFilled(text);
  };

  const choose = (label: string) => {
    // Questions can grow while the call streams in; answers follow them.
    const next = questions.map((_, i) => {
      const a = answers[i] ?? [];
      if (i !== at) return a;
      if (!q.multiSelect) return [label];
      return a.includes(label) ? a.filter((x) => x !== label) : [...a, label];
    });
    setAnswers(next);
    if (quick) fill(label);
    else if (!q.multiSelect && at < total - 1) setIndex(at + 1);
  };

  return (
    <div
      role="group"
      aria-label={total > 1 ? `问题 ${at + 1}/${total}` : q.question}
      data-hc-ask-card=""
      className="mt-2 mb-2 rounded-lg bg-surface-raised p-3 font-sans ring-1 ring-surface-border"
    >
      {total > 1 && (
        <div className="mb-2 flex items-center gap-2 text-caption text-muted-foreground">
          <span className="tabular-nums" data-hc-ask-step="">
            问题 {at + 1}/{total}
          </span>
          <div className="flex flex-1 gap-1" aria-hidden>
            {questions.map((_, i) => (
              <span
                key={i}
                className={cn(
                  'h-1 flex-1 rounded-full transition-colors',
                  i === at
                    ? 'bg-foreground/60'
                    : (answers[i]?.length ?? 0) > 0
                      ? 'bg-foreground/25'
                      : 'bg-muted',
                )}
              />
            ))}
          </div>
        </div>
      )}
      <div
        key={at}
        className="animate-in duration-200 fade-in slide-in-from-right-1 motion-reduce:animate-none"
      >
        <div className="mb-2 text-body font-medium text-foreground">
          {q.question}
          {q.multiSelect && (
            <span className="ml-1.5 text-caption font-normal text-muted-foreground">
              可多选
            </span>
          )}
        </div>
        {q.options.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {q.options.map((label, oi) => {
              const on = chosen.includes(label);
              return (
                <button
                  key={oi}
                  type="button"
                  aria-pressed={on}
                  onClick={() => choose(label)}
                  className={cn(
                    'inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-2.5 text-caption font-medium ring-1 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:h-10',
                    on
                      ? 'bg-foreground text-background ring-foreground'
                      : 'bg-muted text-foreground ring-surface-border hover:bg-surface-hover',
                  )}
                >
                  {on && <Check className="size-3.5" aria-hidden />}
                  {label}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {quick ? (
        <div className="mt-2 text-caption text-muted-foreground">
          {filled
            ? '已填入输入框，可修改后发送'
            : '点选项填入输入框，或直接输入回复后发送'}
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-1.5">
          {total > 1 && (
            <>
              <NavButton
                label="上一题"
                disabled={at === 0}
                onClick={() => setIndex(at - 1)}
              >
                <ChevronLeft className="size-4" aria-hidden />
              </NavButton>
              <NavButton
                label="下一题"
                disabled={at === total - 1}
                onClick={() => setIndex(at + 1)}
              >
                <ChevronRight className="size-4" aria-hidden />
              </NavButton>
            </>
          )}
          <span className="flex-1 truncate text-caption text-muted-foreground">
            {filled && filled === reply
              ? '已填入输入框，可修改后发送'
              : total > 1
                ? `已答 ${answered}/${total}`
                : '选好后填入输入框，或直接输入回复'}
          </span>
          <button
            type="button"
            disabled={!reply || reply === filled}
            onClick={() => fill(reply)}
            className="inline-flex h-7 shrink-0 cursor-pointer items-center rounded-md bg-foreground px-3 text-caption font-medium text-background transition-opacity outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default disabled:opacity-40 pointer-coarse:h-10"
          >
            {filled && filled === reply ? '已填入' : '填入输入框'}
          </button>
        </div>
      )}
    </div>
  );
}

function NavButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground ring-1 ring-surface-border transition-colors outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default disabled:opacity-40 pointer-coarse:size-10"
    >
      {children}
    </button>
  );
}

/**
 * The reply text: one question gives its answers alone; several give each
 * answer under its question. No `1.` numbering: the composer would turn it
 * into a list and drop the numbers.
 */
export function composeReply(
  questions: readonly StepQuestion[],
  answers: readonly (readonly string[])[],
): string {
  if (questions.length === 1) return (answers[0] ?? []).join('、');
  return questions
    .map((q, i) =>
      (answers[i]?.length ?? 0) > 0
        ? `${q.question}\n答：${answers[i].join('、')}`
        : '',
    )
    .filter(Boolean)
    .join('\n');
}
