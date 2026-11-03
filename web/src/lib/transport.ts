export const routerMode = import.meta.env.VITE_ROUTER === '1'
// Standalone, same-origin API. The HttpOnly session belongs to this app.
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  headers.set('X-Mihomo-Request', '1')
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
  })
  if (response.status === 401 && !path.startsWith('/api/auth/'))
    window.dispatchEvent(new Event('mihomo-auth-required'))
  return response
}
