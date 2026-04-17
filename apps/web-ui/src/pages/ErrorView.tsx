import { AlertTriangle } from 'lucide-react';
import { Link, useRouteError } from 'react-router-dom';

import { Button } from '~/components/Button';
import { Card } from '~/components/Card';

export function ErrorView() {
  const error = useRouteError();
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';

  return (
    <div className="mx-auto flex min-h-screen max-w-xl items-center px-6">
      <Card className="w-full">
        <div className="flex items-center gap-3 pb-3">
          <AlertTriangle className="h-5 w-5 text-[color:var(--color-ship)]" />
          <h1 className="text-2xl font-semibold tracking-display-lg">Something went wrong</h1>
        </div>
        <p className="whitespace-pre-wrap font-mono text-sm text-[color:var(--color-ink-subtle)]">
          {message}
        </p>
        <div className="mt-6">
          <Link to="/overview">
            <Button variant="ghost">Back to overview</Button>
          </Link>
        </div>
      </Card>
    </div>
  );
}
