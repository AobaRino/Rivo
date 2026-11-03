import { apiFetch } from './transport'
import type { GroupMember, OrderPreview } from './groupOrder'

export type Runtime = {
  mode: string
  logLevel: string
  running: boolean
  selected: Record<string, string>
  startedAt?: string
}
export type CoreMetrics = {
  available: boolean
  sampledAt?: string
  downloadRate: number | null
  uploadRate: number | null
  connections: number
  memory: number | null
  error?: string
}
export type ProfileSummary = { id: string; name: string; savedAt: string; revision: string }
export type LocalProfile = {
  id: string
  name: string
  draft: string
  savedAt: string
  history: Revision[]
}
export type LocalEvent = { at: string; title: string; detail: string }
export type RuntimePatch = Partial<Runtime> & { restart?: boolean; autoStart?: boolean }
export type Revision = {
  id: string
  kind: 'initial' | 'save' | 'apply' | 'core-apply'
  at: string
  text: string
}
export type State = {
  draft: string
  applied: string
  revision: string
  savedAt: string
  appliedAt: string
  runtime: Runtime
  metrics?: CoreMetrics
  history: Revision[]
  simulation: boolean
  networkEnabled?: boolean
  profileID?: string
  profileName?: string
  profiles?: ProfileSummary[]
  profilesRevision?: string
  autoStart?: boolean
  events?: LocalEvent[]
  appliedRevision?: string
  applicationError?: string
  core?: {
    currentID: string
    controlAvailable?: boolean
    version?: string
    processState?: 'running' | 'stopped' | 'unknown'
    apiReady?: boolean
    busy: boolean
    running: boolean
    operation: { kind: string; phase: string; status: string; error?: string }
  }
}
export type Diagnostic = { severity: 'error' | 'warning'; message: string }
export type ProviderRuntimeStatus = {
  appliedRevision: string
  providers: {
    name: string
    type: string
    nodes: number
    members?: { name: string; type: string }[]
    updatedAt?: string
    state: 'loaded' | 'empty' | 'missing'
  }[]
}
export type WorkspaceStatus = Pick<
  State,
  | 'revision'
  | 'simulation'
  | 'core'
  | 'appliedRevision'
  | 'networkEnabled'
  | 'runtime'
  | 'metrics'
  | 'profileID'
  | 'profilesRevision'
  | 'autoStart'
  | 'events'
>

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    signal: AbortSignal.timeout(15000),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '本地服务请求失败')
  return data
}
export const api = {
  coreControl: (action: 'start' | 'stop' | 'restart', expectedApplied: string) =>
    request<State>('/core/control', {
      method: 'POST',
      body: JSON.stringify({ action, expectedApplied }),
    }),
  state: () => request<State>('/state'),
  status: () => request<WorkspaceStatus>('/status'),
  providers: () => request<ProviderRuntimeStatus>('/core/providers'),
  groupOrderPreview: (input: OrderPreview) =>
    request<{ members: GroupMember[] }>('/group-order/preview', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  save: (text: string, revision: string, profileID = 'default') =>
    request<State>('/draft', {
      method: 'PUT',
      headers: { 'If-Match': revision, 'X-Profile-ID': profileID },
      body: JSON.stringify({ text }),
    }),
  apply: (
    revision: string,
    expectedCurrent?: string,
    expectedApplied?: string,
    profileID = 'default',
  ) =>
    request<State>('/apply', {
      method: 'POST',
      headers: { 'X-Profile-ID': profileID },
      body: JSON.stringify({ revision, expectedCurrent, expectedApplied }),
    }),
  validate: (text: string) =>
    request<{ valid: boolean; diagnostics: Diagnostic[]; coreValidated: false }>('/validate', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  runtime: (patch: RuntimePatch | { group: string; selection: string }, profileID = 'default') =>
    request<State>('/runtime', {
      method: 'PATCH',
      headers: { 'X-Profile-ID': profileID },
      body: JSON.stringify(patch),
    }),
  profile: (id: string) =>
    request<{ profile: LocalProfile; profilesRevision: string }>(
      `/profiles/${encodeURIComponent(id)}`,
    ),
  createProfile: (name: string, text: string, expected: string) =>
    request<State>('/profiles', { method: 'POST', body: JSON.stringify({ name, text, expected }) }),
  renameProfile: (id: string, name: string, expected: string) =>
    request<State>(`/profiles/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name, expected }),
    }),
  deleteProfile: (id: string, expected: string) =>
    request<State>(`/profiles/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: JSON.stringify({ expected }),
    }),
  switchProfile: (
    id: string,
    expected: string,
    profileID: string,
    revision: string,
    saveCurrent?: string,
  ) =>
    request<State>(`/profiles/${encodeURIComponent(id)}/switch`, {
      method: 'POST',
      headers: { 'X-Profile-ID': profileID },
      body: JSON.stringify({ expected, revision, saveCurrent }),
    }),
}
