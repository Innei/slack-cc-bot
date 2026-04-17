import { motion } from 'motion/react';
import { Outlet, useLocation } from 'react-router-dom';

import { Sidebar } from '~/components/Sidebar';
import { TopBar } from '~/components/TopBar';

export function RootLayout() {
  const location = useLocation();

  return (
    <div className="flex h-full min-h-screen bg-white">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10 md:px-10">
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col gap-10"
            initial={{ opacity: 0, y: 8 }}
            key={location.pathname}
            transition={{ duration: 0.25, ease: 'easeOut' }}
          >
            <Outlet />
          </motion.div>
        </main>
      </div>
    </div>
  );
}
