import type { StepQuestion } from '../../lib/stream-steps';
import { useShellStore } from '../../stores/shell';

/**
 * AskUserQuestion options. The runner has no interactive answer channel, so
 * the reply is the user's next message: an option click fills the composer.
 * An option is as tall as its text: a long label wraps and what it means is
 * said under it.
 */
export function AskUserQuestionCard({
  questions,
}: {
  questions: readonly StepQuestion[];
}) {
  if (questions.length === 0) return null;

  return (
    <div className="mt-2 mb-2 space-y-2">
      {questions.map((q, qi) => (
        <div
          key={qi}
          className="rounded-lg bg-surface-raised p-3 font-sans ring-1 ring-surface-border"
        >
          <div className="mb-2 text-body font-medium break-words text-foreground">
            {q.question}
          </div>
          {q.options.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {q.options.map((label, oi) => {
                const description = q.descriptions?.[oi];
                return (
                  <button
                    key={oi}
                    type="button"
                    onClick={() =>
                      useShellStore.getState().requestComposerDraft(label)
                    }
                    data-hc-question-option=""
                    className="inline-flex min-h-7 max-w-full cursor-pointer flex-col items-start justify-center rounded-md bg-muted px-2.5 py-1 text-left text-caption font-medium break-words text-foreground ring-1 ring-surface-border transition-colors outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:min-h-11 pointer-coarse:py-2"
                  >
                    <span>{label}</span>
                    {description && (
                      <span className="mt-0.5 font-normal text-muted-foreground">
                        {description}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          <div className="mt-2 text-caption text-muted-foreground">
            点选项填入输入框，或直接输入回复后发送
          </div>
        </div>
      ))}
    </div>
  );
}
