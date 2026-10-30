import { Fragment, type ComponentProps, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';

export interface SheetAction {
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
}

interface ActionSheetProps extends Omit<
  ComponentProps<typeof SheetContent>,
  'title' | 'children'
> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  /** Rows in groups, split by a hairline; empty groups are skipped. */
  groups: SheetAction[][];
  /** The control that opens it, when the sheet owns its trigger. */
  trigger?: ReactNode;
}

/**
 * A phone's bottom sheet of actions (cindy's panel rows: 16/22, medium,
 * 48px tall). A row runs its action first, inside the tap, so a file picker
 * it opens still counts as user-started, then closes the sheet.
 */
export function ActionSheet({
  open,
  onOpenChange,
  title,
  description,
  groups,
  trigger,
  ...contentProps
}: ActionSheetProps) {
  const shown = groups.filter((group) => group.length > 0);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {trigger && <SheetTrigger asChild>{trigger}</SheetTrigger>}
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="gap-0 p-0"
        {...contentProps}
      >
        <SheetTitle className="sr-only">{title}</SheetTitle>
        <SheetDescription className="sr-only">{description}</SheetDescription>
        <div className="flex flex-col px-2 pt-1 pb-2">
          {shown.map((group, index) => (
            <Fragment key={group[0].label}>
              {index > 0 && (
                <div
                  role="separator"
                  className="mx-3 my-1 h-px bg-surface-border"
                />
              )}
              {group.map(({ label, icon: Icon, onSelect, disabled }) => (
                <button
                  key={label}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    onSelect();
                    onOpenChange(false);
                  }}
                  className="flex h-12 w-full cursor-pointer items-center gap-3 rounded-[12px] px-3 text-left text-base leading-[22px] font-medium text-foreground transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none active:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none"
                >
                  <Icon
                    className="size-[18px] shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  {label}
                </button>
              ))}
            </Fragment>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
