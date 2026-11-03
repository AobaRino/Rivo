import React, { lazy, Suspense } from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Route, Routes } from 'react-router'
import { AuthBoundary } from './features/auth/AuthBoundary'
import { ErrorBoundary } from './app/ErrorBoundary'
import './styles.css'
const App = lazy(() => import('./App'))
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 3000, refetchOnWindowFocus: true } },
})
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthBoundary>
            <Suspense
              fallback={
                <main className="app-loading" role="status">
                  正在载入工作空间…
                </main>
              }
            >
              <Routes>
                <Route path="/:page?" element={<App />} />
                <Route path="*" element={<App />} />
              </Routes>
            </Suspense>
          </AuthBoundary>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
)
