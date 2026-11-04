import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestAuth } from './request'

afterEach(() => vi.unstubAllGlobals())

describe('authentication request contract', () => {
  it('logs out with POST even though logout has no request body', async () => {
    const fetch = vi.fn(async (_path: string, init: RequestInit) =>
      init.method === 'POST'
        ? Response.json({ authenticated: false })
        : Response.json({ error: '不支持的操作' }, { status: 405 }),
    )
    vi.stubGlobal('fetch', fetch)

    await expect(requestAuth('logout')).resolves.toEqual({ authenticated: false })
    const [path, init] = fetch.mock.calls[0]
    expect(path).toBe('/api/auth/logout')
    expect(init.method).toBe('POST')
    expect(init.body).toBeUndefined()
    expect(init.credentials).toBe('same-origin')
    expect(init.cache).toBe('no-store')
    expect(new Headers(init.headers).get('X-Mihomo-Request')).toBe('1')
  })

  it('checks the session with GET without a body', async () => {
    const fetch = vi.fn(async (_path: string, _init: RequestInit) =>
      Response.json({ authenticated: true }),
    )
    vi.stubGlobal('fetch', fetch)

    await expect(requestAuth('session')).resolves.toEqual({ authenticated: true })
    const [path, init] = fetch.mock.calls[0]
    expect(path).toBe('/api/auth/session')
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined()
  })

  it.each(['login', 'setup'] as const)(
    'submits %s credentials as JSON with POST',
    async (action) => {
      const fetch = vi.fn(async (_path: string, _init: RequestInit) =>
        Response.json({ authenticated: true }),
      )
      vi.stubGlobal('fetch', fetch)
      const body = {
        password: 'test-password-only',
        remember: true,
        ...(action === 'setup' ? { token: 'test-token-only' } : {}),
      }

      await requestAuth(action, body)
      const [path, init] = fetch.mock.calls[0]
      expect(path).toBe(`/api/auth/${action}`)
      expect(init.method).toBe('POST')
      expect(new Headers(init.headers).get('Content-Type')).toBe('application/json')
      expect(JSON.parse(init.body as string)).toEqual(body)
    },
  )

  it('rejects a failed revocation instead of reporting a successful logout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: '退出登录未完成：无法保存会话撤销记录，请重试' }, { status: 500 }),
      ),
    )
    await expect(requestAuth('logout')).rejects.toThrow('退出登录未完成')
  })
})
