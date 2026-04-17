import { Card } from '~/components/Card';
import { LoadingBlock } from '~/components/LoadingBlock';
import { PageHeader } from '~/components/PageHeader';
import { useVersion } from '~/lib/queries';

export function SettingsPage() {
  const { data, isLoading } = useVersion();

  return (
    <>
      <PageHeader
        description="Build metadata and runtime information for the currently connected bot."
        eyebrow="Runtime"
        title="Settings"
      />

      {isLoading ? (
        <LoadingBlock className="h-40" />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Card className="flex flex-col gap-1.5" padding="sm">
            <span className="font-mono text-xs tracking-wide uppercase text-[color:var(--color-ink-faint)]">
              Version
            </span>
            <span className="font-mono text-sm">{data?.version ?? '—'}</span>
          </Card>
          <Card className="flex flex-col gap-1.5" padding="sm">
            <span className="font-mono text-xs tracking-wide uppercase text-[color:var(--color-ink-faint)]">
              Git hash
            </span>
            <span className="font-mono text-sm">{data?.gitHash ?? '—'}</span>
          </Card>
          <Card className="flex flex-col gap-1.5" padding="sm">
            <span className="font-mono text-xs tracking-wide uppercase text-[color:var(--color-ink-faint)]">
              Commit date
            </span>
            <span className="font-mono text-sm">{data?.commitDate ?? '—'}</span>
          </Card>
          <Card className="flex flex-col gap-1.5" padding="sm">
            <span className="font-mono text-xs tracking-wide uppercase text-[color:var(--color-ink-faint)]">
              Node env
            </span>
            <span className="font-mono text-sm">{data?.nodeEnv ?? '—'}</span>
          </Card>
        </div>
      )}
    </>
  );
}
