import { BrowserRouter, Route, Routes } from 'react-router';

import { RootLayout } from '~/layouts/root-layout';
import { DashboardPage } from '~/pages/dashboard';
import { SessionsPage } from '~/pages/sessions';
import { SettingsPage } from '~/pages/settings';
import { WorkspacesPage } from '~/pages/workspaces';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<RootLayout />}>
          <Route index element={<DashboardPage />} />
          <Route element={<SessionsPage />} path="sessions" />
          <Route element={<WorkspacesPage />} path="workspaces" />
          <Route element={<SettingsPage />} path="settings" />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
