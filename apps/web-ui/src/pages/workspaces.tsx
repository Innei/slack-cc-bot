import { FolderGit2, GitBranch, Loader2 } from 'lucide-react';
import { motion } from 'motion/react';

import { Badge } from '~/components/badge';
import { Card } from '~/components/card';
import { EmptyState } from '~/components/empty-state';
import { useWorkspaces } from '~/hooks/use-api';

export function WorkspacesPage() {
  const { data: workspaces, isLoading } = useWorkspaces();

  return (
    <div>
      <motion.div animate={{ opacity: 1, y: 0 }} initial={{ opacity: 0, y: 8 }}>
        <h1
          className="text-[48px] font-semibold text-gray-900"
          style={{ letterSpacing: '-2.4px', lineHeight: '1.17' }}
        >
          Workspaces
        </h1>
        <p className="mt-3 text-[20px] leading-relaxed text-gray-600">
          Manage discovered repositories and workspace mappings.
        </p>
      </motion.div>

      <motion.div
        animate={{ opacity: 1, y: 0 }}
        className="mt-10"
        initial={{ opacity: 0, y: 12 }}
        transition={{ delay: 0.05 }}
      >
        {isLoading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="size-5 animate-spin text-gray-400" strokeWidth={1.5} />
          </div>
        ) : workspaces && workspaces.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {workspaces.map((w) => (
              <Card key={w.path}>
                <div className="flex items-start gap-3">
                  <FolderGit2 className="mt-0.5 size-4 shrink-0 text-gray-400" strokeWidth={1.5} />
                  <div className="min-w-0">
                    <p className="text-[16px] font-semibold text-gray-900">{w.name}</p>
                    <p className="mt-1 truncate text-[13px] text-gray-500 font-mono">{w.path}</p>
                    {w.branch && (
                      <div className="mt-2 flex items-center gap-1.5">
                        <GitBranch className="size-3 text-gray-400" strokeWidth={1.5} />
                        <Badge>{w.branch}</Badge>
                      </div>
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        ) : (
          <EmptyState
            description="Workspaces are discovered from the configured repository root directory."
            icon={FolderGit2}
            title="No workspaces configured"
          />
        )}
      </motion.div>
    </div>
  );
}
