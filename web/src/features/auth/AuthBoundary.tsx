import { useEffect, useRef, useState, type ReactNode, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LockKeyhole } from 'lucide-react'
import { APP_NAME, BrandMark } from '../../components/Brand'
import { apiFetch } from '../../lib/transport'
import './auth.css'

type Session = { authenticated: boolean; setupRequired?: boolean; development?: boolean }
async function request(path: string, body?: object): Promise<Session> {
  const response = await apiFetch(
    `/api/auth/${path}`,
    body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : undefined,
  )
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '无法连接登录服务')
  return data
}
export function AuthBoundary({ children }: { children: ReactNode }) {
  const client = useQueryClient()
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => request('session'),
    retry: false,
    refetchInterval: 60000,
  })
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [remember, setRemember] = useState(false)
  const [token] = useState(() => {
    const value = new URLSearchParams(location.hash.slice(1)).get('setup') || ''
    return value
  })
  useEffect(() => {
    if (token) history.replaceState(null, '', location.pathname + location.search)
  }, [token])
  const entered = useRef(false)
  if (session.data?.authenticated) entered.current = true
  const setup = session.data?.setupRequired
  const login = useMutation({
    mutationFn: () =>
      request(setup ? 'setup' : 'login', { password, remember, ...(setup ? { token } : {}) }),
    onSuccess: (data) => {
      setPassword('')
      setConfirm('')
      setRemember(false)
      client.setQueryData(['session'], data)
    },
    onError: () => void client.invalidateQueries({ queryKey: ['session'] }),
  })
  useEffect(() => {
    const expired = () =>
      client.setQueryData<Session>(['session'], (old) => ({ ...old, authenticated: false }))
    window.addEventListener('mihomo-auth-required', expired)
    return () => window.removeEventListener('mihomo-auth-required', expired)
  }, [client])
  function submit(event: FormEvent) {
    event.preventDefault()
    if (setup && password !== confirm) return
    login.mutate()
  }
  const authenticated = session.data?.authenticated
  return (
    <>
      {entered.current && <div hidden={!authenticated}>{children}</div>}
      {!authenticated && (
        <main className="auth-shell">
          <section className="auth-card">
            <div className="auth-brand">
              <BrandMark />
              <span>{APP_NAME}</span>
            </div>
            <h1>{setup ? '设置管理密码' : '登录管理器'}</h1>
            <p>
              {setup
                ? '此密码用于独立 Web 面板，与路由器登录密码无关。'
                : '登录后管理配置和查看运行状态。'}
            </p>
            {session.isPending ? (
              <p role="status">正在连接服务…</p>
            ) : session.error ? (
              <>
                <p role="alert">{session.error.message}</p>
                <button className="button" onClick={() => void session.refetch()}>
                  重试
                </button>
              </>
            ) : setup && !token ? (
              <p role="alert">
                请从 LuCI 的 {APP_NAME} 页面打开初始化入口，或使用服务器上的初始化令牌。
              </p>
            ) : (
              <form onSubmit={submit}>
                <label>
                  管理密码
                  <input
                    autoFocus
                    type="password"
                    name="password"
                    autoComplete={setup ? 'new-password' : 'current-password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    minLength={setup ? 12 : 1}
                    maxLength={1024}
                    required
                  />
                </label>
                {setup && (
                  <label>
                    确认密码
                    <input
                      type="password"
                      name="confirm-password"
                      autoComplete="new-password"
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      minLength={12}
                      required
                    />
                  </label>
                )}
                {setup && confirm && password !== confirm && (
                  <p role="alert">两次输入的密码不一致。</p>
                )}
                <div className="auth-session-option">
                  <label className="checkbox-line">
                    <input
                      type="checkbox"
                      name="remember"
                      checked={remember}
                      onChange={(e) => setRemember(e.target.checked)}
                      disabled={login.isPending}
                      aria-describedby="auth-remember-help"
                    />
                    保持登录 30 天
                  </label>
                  <p id="auth-remember-help">勾选后，升级或重启服务仍保持登录。</p>
                </div>
                {login.error && <p role="alert">{login.error.message}</p>}
                <button
                  className="button primary"
                  disabled={login.isPending || !!(setup && password !== confirm)}
                >
                  <LockKeyhole size={16} />
                  {login.isPending ? '正在验证…' : setup ? '设置并登录' : '登录'}
                </button>
              </form>
            )}
          </section>
        </main>
      )}
    </>
  )
}
export function SignOut({ onError }: { onError: (error: Error) => void }) {
  const client = useQueryClient()
  const session = useQuery<Session>({ queryKey: ['session'], queryFn: () => request('session') })
  const logout = useMutation({
    mutationFn: () => request('logout'),
    onSuccess: (data) => client.setQueryData(['session'], data),
    onError,
  })
  if (session.data?.development) return null
  return (
    <button className="button small" disabled={logout.isPending} onClick={() => logout.mutate()}>
      退出登录
    </button>
  )
}
