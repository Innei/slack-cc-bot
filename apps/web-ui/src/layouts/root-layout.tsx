import { Outlet } from 'react-router';

import { Navbar } from '~/components/navbar';

export function RootLayout() {
  return (
    <div className="min-h-screen bg-white">
      <Navbar />
      <main className="mx-auto max-w-[1200px] px-6 py-10">
        <Outlet />
      </main>
    </div>
  );
}
