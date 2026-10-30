import { Fragment, useState, type JSX, type ReactElement } from 'react';
import type { LucideIcon } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useIsPhone } from '@/components/layout/phone';
import { ActionSheet } from './ActionSheet';

export interface MenuAction {
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
}

/**
 * One menu, two forms: an anchored DropdownMenu on a desktop, a bottom
 * ActionSheet of 48px rows on a phone (cindy's showActionMenu). Groups are
 * split by a separator; empty ones are skipped. Open state is optional to
 * control.
 */
export function ResponsiveMenu({
  trigger,
  groups,
  title,
  description,
  align = 'end',
  open: openProp,
  onOpenChange,
}: {
  trigger: ReactElement;
  groups: MenuAction[][];
  title: string;
  description?: string;
  align?: 'start' | 'center' | 'end';
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
}): JSX.Element {
  const isPhone = useIsPhone();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = openProp ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const shown = groups.filter((group) => group.length > 0);

  if (isPhone) {
    return (
      <ActionSheet
        open={open}
        onOpenChange={setOpen}
        title={title}
        description={description}
        groups={shown}
        trigger={trigger}
      />
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} aria-label={title} className="w-auto">
        {shown.map((group, index) => (
          <Fragment key={group[0].label}>
            {index > 0 && <DropdownMenuSeparator />}
            {group.map(
              ({ label, icon: Icon, onSelect, disabled, destructive }) => (
                <DropdownMenuItem
                  key={label}
                  disabled={disabled}
                  variant={destructive ? 'destructive' : 'default'}
                  onSelect={onSelect}
                >
                  {Icon && <Icon aria-hidden="true" />}
                  {label}
                </DropdownMenuItem>
              ),
            )}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
