import { FolderGit2 } from 'lucide-react';
import { motion } from 'motion/react';

import { EmptyState } from '~/components/empty-state';

export function WorkspacesPage() {
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
        <EmptyState
          description="Workspaces are discovered from the configured repository root directory."
          icon={FolderGit2}
          title="No workspaces configured"
        />
      </motion.div>
    </div>
  );
}
