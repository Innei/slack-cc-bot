import { GitBranch, Radio } from 'lucide-react';

import { useVersion } from '~/lib/queries';

import { Badge } from './Badge';

export function TopBar() {
  const { data, isLoading, isError } = useVersion();

  return (
    <header className="flex h-14 items-center justify-between border-b border-[color:var(--color-line)] bg-white px-6">
      <div className="flex items-center gap-3">
        <div className="font-mono text-xs tracking-wide uppercase text-[color:var(--color-ink-faint)]">
          Kagura · Dashboard
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs text-[color:var(--color-ink-subtle)]">
        <Badge className="gap-1" tone={isError ? 'ship' : 'develop'}>
          <Radio className="h-3 w-3" strokeWidth={2} />
          {isError ? 'Offline' : isLoading ? 'Connecting' : 'Live'}
        </Badge>
        {data && (
          <span className="shadow-ring-light flex items-center gap-1.5 rounded-md bg-white px-2 py-1 font-mono text-xs">
            <GitBranch className="h-3 w-3" strokeWidth={2} />
            {data.gitHash.slice(0, 7)}
          </span>
        )}
      </div>
    </header>
  );
}
