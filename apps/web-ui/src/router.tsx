import type { RouteObject } from 'react-router-dom';
import { createBrowserRouter, Navigate } from 'react-router-dom';

import { RootLayout } from '~/layouts/RootLayout';
import { ErrorView } from '~/pages/ErrorView';
import { MemoryPage } from '~/pages/MemoryPage';
import { OverviewPage } from '~/pages/OverviewPage';
import { SessionDetailPage } from '~/pages/SessionDetailPage';
import { SessionsPage } from '~/pages/SessionsPage';
import { SettingsPage } from '~/pages/SettingsPage';
import { WorkspacesPage } from '~/pages/WorkspacesPage';

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <RootLayout />,
    errorElement: <ErrorView />,
    children: [
      { index: true, element: <Navigate replace to="/overview" /> },
      { path: 'overview', element: <OverviewPage /> },
      { path: 'sessions', element: <SessionsPage /> },
      { path: 'sessions/:threadTs', element: <SessionDetailPage /> },
      { path: 'memory', element: <MemoryPage /> },
      { path: 'workspaces', element: <WorkspacesPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
