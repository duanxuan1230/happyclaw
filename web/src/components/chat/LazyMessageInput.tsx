import { createContext, memo, useContext, type ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { preloadedComponent } from '../../lib/preloaded-component';
import { useIsPhone } from '../layout/phone';
import type { MessageInput as EagerMessageInput } from './MessageInput';

type MessageInputProps = ComponentProps<typeof EagerMessageInput>;

const FallbackLayout = createContext<{
  layout: MessageInputProps['layout'];
  statusBar: boolean;
}>({ layout: 'docked', statusBar: false });

/**
 * The composer's frame while the editor loads, in the size and place of the
 * real one so nothing moves when it arrives.
 */
function ComposerFallback() {
  const { layout, statusBar } = useContext(FallbackLayout);
  const centered = layout === 'centered';
  const dock = useIsPhone() && !centered;
  return (
    <div
      aria-hidden="true"
      data-composer-fallback
      className={cn(
        'relative w-full',
        dock
          ? 'absolute inset-x-0 bottom-0 z-20 pt-6'
          : !centered && 'bg-background pt-1 pb-3',
      )}
      style={
        centered
          ? undefined
          : {
              paddingBottom: dock
                ? 'max(calc(env(safe-area-inset-bottom, 0px) + 8px), calc(var(--keyboard-height, 0px) + 8px))'
                : 'max(0.75rem, env(safe-area-inset-bottom, 0px), var(--keyboard-height, 0px))',
            }
      }
    >
      <div className="mx-auto max-w-3xl px-4 lg:px-6">
        {statusBar && !centered && <div className="mb-1.5 h-8" />}
        <div
          className={cn(
            'border border-surface-border bg-surface-raised',
            dock
              ? 'min-h-[50px] rounded-[25px]'
              : centered
                ? 'min-h-[140px] rounded-[12px]'
                : 'min-h-[96px] rounded-[12px] sm:min-h-[118px]',
          )}
        />
      </div>
    </div>
  );
}

// The editor (Tiptap, ProseMirror and the cindy composer) is most of the chat
// page's code; it loads when a conversation first renders its composer, not
// with the page, so the phone's conversation list never parses it.
const lazyMessageInput = preloadedComponent(
  () => import('./MessageInput').then((m) => ({ default: m.MessageInput })),
  ComposerFallback,
);

/** Fetch the editor chunk ahead of opening a conversation. */
export const preloadMessageInput = lazyMessageInput.preload;

export const MessageInput = memo(function LazyMessageInput(
  props: MessageInputProps,
) {
  const LoadedOrFallback = lazyMessageInput.Component;
  return (
    <FallbackLayout.Provider
      value={{ layout: props.layout, statusBar: !!props.statusBar }}
    >
      <LoadedOrFallback {...props} />
    </FallbackLayout.Provider>
  );
});
