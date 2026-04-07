import { createBrowserRouter } from 'react-router';

import { RootLayout } from '~/layouts/root-layout';
import { DashboardPage } from '~/pages/dashboard';
import { SessionsPage } from '~/pages/sessions';
import { SettingsPage } from '~/pages/settings';
import { WorkspacesPage } from '~/pages/workspaces';

export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'sessions', element: <SessionsPage /> },
      { path: 'workspaces', element: <WorkspacesPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]);
