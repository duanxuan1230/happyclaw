import { useEffect, useRef, useState, type ComponentType } from 'react';
import { cn } from '@/lib/utils';

export interface SegmentedOption<V extends string = string> {
  value: V;
  label: string;
  icon?: ComponentType<{ className?: string }>;
}

export interface SegmentedControlProps<V extends string = string> {
  /** Accessible group label. */
  label: string;
  value: V;
  options: SegmentedOption<V>[];
  onChange: (value: V) => void;
  size?: 'sm' | 'default';
  className?: string;
}

const FADE_START =
  '[mask-image:linear-gradient(to_right,transparent,black_1.5rem)]';
const FADE_END =
  '[mask-image:linear-gradient(to_left,transparent,black_1.5rem)]';
const FADE_BOTH =
  '[mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%-1.5rem),transparent)]';

/** Compact single-choice switcher (pressed-button group). */
export function SegmentedControl<V extends string = string>({
  label,
  value,
  options,
  onChange,
  size = 'default',
  className,
}: SegmentedControlProps<V>) {
  // When the options overflow (narrow phones), the clipped edge fades out so
  // it reads as scrollable; there is no fade while everything fits.
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  const optionKey = options.map((option) => option.label).join('\n');
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => {
      const maxScroll = node.scrollWidth - node.clientWidth;
      const next = {
        start: node.scrollLeft > 2,
        end: node.scrollLeft < maxScroll - 2,
      };
      setEdges((current) =>
        current.start === next.start && current.end === next.end
          ? current
          : next,
      );
    };
    update();
    node.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => {
      node.removeEventListener('scroll', update);
      observer.disconnect();
    };
    // Options can change width without resizing the clipped box.
  }, [optionKey]);

  return (
    <div
      ref={ref}
      role="group"
      aria-label={label}
      data-slot="segmented-control"
      className={cn(
        'inline-flex min-w-0 max-w-full gap-0.5 overflow-x-auto rounded-lg bg-muted p-0.5',
        edges.start && edges.end
          ? FADE_BOTH
          : edges.start
            ? FADE_START
            : edges.end && FADE_END,
        className,
      )}
    >
      {options.map((option) => {
        const Icon = option.icon;
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 font-medium whitespace-nowrap transition-colors duration-100 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-11',
              size === 'sm' ? 'h-6 text-caption' : 'h-7 text-label',
              active
                ? 'bg-background text-foreground shadow-xs ring-1 ring-surface-border dark:bg-surface-selected'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {Icon && <Icon className="size-3.5" />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
