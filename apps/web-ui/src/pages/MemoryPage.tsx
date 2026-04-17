import { useAtom } from 'jotai';
import { Search, Sparkles } from 'lucide-react';
import { useMemo } from 'react';

import { Badge } from '~/components/Badge';
import { Card } from '~/components/Card';
import { EmptyState } from '~/components/EmptyState';
import { LoadingBlock } from '~/components/LoadingBlock';
import { PageHeader } from '~/components/PageHeader';
import { formatRelativeTime } from '~/lib/format';
import { useMemory, useWorkspaces } from '~/lib/queries';
import type { MemoryRecord } from '~/lib/types';
import { memoryCategoryAtom, memoryQueryAtom, repoFilterAtom } from '~/stores/filters';

const CATEGORIES = ['task_completed', 'decision', 'context', 'observation', 'preference'] as const;

export function MemoryPage() {
  const [query, setQuery] = useAtom(memoryQueryAtom);
  const [category, setCategory] = useAtom(memoryCategoryAtom);
  const [repoId, setRepoId] = useAtom(repoFilterAtom);
  const workspaces = useWorkspaces();

  const memoryParams = useMemo(() => {
    const params: { category?: string; limit: number; query?: string; repoId?: string } = {
      limit: 100,
    };
    if (query.trim()) params.query = query.trim();
    if (category) params.category = category;
    if (repoId) params.repoId = repoId;
    return params;
  }, [query, category, repoId]);

  const memory = useMemory(memoryParams);

  return (
    <>
      <PageHeader
        description="Searchable slice of the agent's cross-thread and workspace memory."
        eyebrow="Recall"
        title="Memory"
      />

      <Card padding="sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <div className="flex flex-1 items-center gap-2 rounded-md bg-[color:var(--color-surface-tint)] px-3 py-2 shadow-ring-light">
            <Search className="h-4 w-4 text-[color:var(--color-ink-faint)]" />
            <input
              className="w-full bg-transparent text-sm outline-none placeholder:text-[color:var(--color-ink-faint)]"
              placeholder="Search memory contents…"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <select
            className="shadow-ring-light h-9 rounded-md border-0 bg-white px-3 text-sm outline-none"
            value={category ?? ''}
            onChange={(e) => setCategory(e.target.value || undefined)}
          >
            <option value="">All categories</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c.replace('_', ' ')}
              </option>
            ))}
          </select>
          <select
            className="shadow-ring-light h-9 rounded-md border-0 bg-white px-3 text-sm outline-none"
            value={repoId ?? ''}
            onChange={(e) => setRepoId(e.target.value || undefined)}
          >
            <option value="">All workspaces</option>
            {(workspaces.data ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
              </option>
            ))}
          </select>
        </div>
      </Card>

      {memory.isLoading ? (
        <LoadingBlock className="h-64" />
      ) : (memory.data?.rows.length ?? 0) === 0 ? (
        <Card>
          <EmptyState
            description="Memory is created as the agent observes or completes tasks — try running a session first."
            icon={Sparkles}
            title="No memory entries"
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {memory.data!.rows.map((row) => (
            <MemoryCard key={row.id} row={row} />
          ))}
        </div>
      )}
    </>
  );
}

function MemoryCard({ row }: { row: MemoryRecord }) {
  return (
    <Card className="flex flex-col gap-3" padding="sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge tone={row.scope === 'global' ? 'ink' : 'develop'}>{row.scope}</Badge>
          <Badge tone="neutral">{row.category.replace('_', ' ')}</Badge>
        </div>
        <span className="text-xs text-[color:var(--color-ink-faint)]">
          {formatRelativeTime(row.createdAt)}
        </span>
      </div>
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-[color:var(--color-ink)]">
        {row.content}
      </p>
      {(row.repoId || row.threadTs) && (
        <div className="flex flex-wrap gap-2 font-mono text-[11px] text-[color:var(--color-ink-faint)]">
          {row.repoId && <span>repo: {row.repoId}</span>}
          {row.threadTs && <span>thread: {row.threadTs}</span>}
        </div>
      )}
    </Card>
  );
}
