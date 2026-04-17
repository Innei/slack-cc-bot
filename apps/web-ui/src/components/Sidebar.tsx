import {
  Activity,
  Building2,
  type LucideIcon,
  MessageSquareText,
  Settings,
  Sparkles,
} from 'lucide-react';
import { NavLink } from 'react-router-dom';

import { cn } from '~/lib/cn';

interface NavItem {
  icon: LucideIcon;
  label: string;
  to: string;
}

const items: NavItem[] = [
  { icon: Activity, label: 'Overview', to: '/overview' },
  { icon: MessageSquareText, label: 'Sessions', to: '/sessions' },
  { icon: Sparkles, label: 'Memory', to: '/memory' },
  { icon: Building2, label: 'Workspaces', to: '/workspaces' },
  { icon: Settings, label: 'Settings', to: '/settings' },
];

export function Sidebar() {
  return (
    <aside className="hidden w-64 shrink-0 border-r border-[color:var(--color-line)] bg-white md:block">
      <div className="flex h-14 items-center gap-2 px-5 font-semibold tracking-display-md">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[color:var(--color-ink)] text-white">
          <Sparkles className="h-4 w-4" strokeWidth={2} />
        </span>
        <span>Kagura</span>
      </div>
      <nav className="flex flex-col gap-0.5 px-3 pt-3">
        {items.map((item) => (
          <NavLink
            end={false}
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                isActive
                  ? 'bg-[color:var(--color-surface-tint)] font-medium text-[color:var(--color-ink)] shadow-ring-light'
                  : 'text-[color:var(--color-ink-subtle)] hover:text-[color:var(--color-ink)]',
              )
            }
          >
            <item.icon className="h-4 w-4" strokeWidth={1.75} />
            <span className="no-underline">{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
