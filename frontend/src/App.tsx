import React, { Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { useAuthStore, useAppStore } from './store';

// Lazy-loaded routes for code splitting
const Landing = React.lazy(() => import('./pages/Landing'));
const Dashboard = React.lazy(() => import('./pages/Dashboard'));
const ResumeBuilder = React.lazy(() => import('./pages/ResumeBuilder'));
const AuthModal = React.lazy(() => import('./components/features/AuthModal'));

import Layout from './components/layout/Layout';
import FullPageLoader from './components/ui/FullPageLoader';
import CookieBanner from './components/ui/CookieBanner';
import ErrorBoundary from './components/ui/ErrorBoundary';

export default function App() {
  const fetchProfile = useAuthStore(s => s.fetchProfile);
  const theme = useAppStore(s => s.theme);

  // Apply theme class
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  // Re-hydrate session on load
  useEffect(() => { fetchProfile(); }, [fetchProfile]);

  return (
    <ErrorBoundary>
      <BrowserRouter>
        <Suspense fallback={<FullPageLoader />}>
          <Routes>
            <Route path="/" element={<Layout />}>
              <Route index element={<Landing />} />
              <Route path="dashboard" element={<Dashboard />} />
              <Route path="resume" element={<ResumeBuilder />} />
            </Route>
          </Routes>
          <CookieBanner />
        </Suspense>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
