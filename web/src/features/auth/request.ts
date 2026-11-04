import { apiFetch } from '../../lib/transport'

export type Session = { authenticated: boolean; setupRequired?: boolean; development?: boolean }
type Credentials = { password: string; remember: boolean; token?: string }
const methods = { session: 'GET', login: 'POST', setup: 'POST', logout: 'POST' } as const

export function requestAuth(action: 'session' | 'logout'): Promise<Session>
export function requestAuth(action: 'login' | 'setup', body: Credentials): Promise<Session>
export async function requestAuth(
  action: keyof typeof methods,
  body?: Credentials,
): Promise<Session> {
  const response = await apiFetch(`/api/auth/${action}`, {
    method: methods[action],
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '无法连接登录服务')
  return data
}
