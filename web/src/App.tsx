import {
  timeLabel,
  Badge,
  IconButton,
  Panel,
  Empty,
  Field,
  TextField,
  Switch,
  ModeControl,
} from './components/WorkspacePrimitives'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { SignOut } from './features/auth/AuthBoundary'
import {
  Activity,
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Code2,
  Copy,
  FileCode2,
  Files,
  FileDiff,
  FolderClock,
  GitBranch,
  Globe2,
  HardDrive,
  Info,
  LayoutDashboard,
  ListFilter,
  Menu,
  MoreHorizontal,
  Network,
  Pencil,
  Play,
  Plus,
  Radio,
  Rss,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  TerminalSquare,
  Trash2,
  Upload,
  Wifi,
  X,
  XCircle,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { api } from './lib/api'
import { apiFetch, routerMode } from './lib/transport'
import { canPollWorkspace, mergePolledState, shouldRefreshWorkspace } from './lib/workspaceSync'
import { type CoreAction } from './lib/homeState'
import type { State, Diagnostic, Revision } from './lib/api'
import {
  addRule,
  analyze,
  appendItem,
  moveItem,
  references,
  removeItem,
  rename,
  setValue,
  setStringList,
} from './lib/document'
import type { Analysis, Config, Group, Path, ProxyNode } from './lib/document'
import { Editor } from './components/Editor'
import { APP_NAME, BrandMark } from './components/Brand'
import { Modal } from './components/Modal'
import { Subscriptions } from './components/Subscriptions'
import { ProviderStatus } from './components/ProviderStatus'
import { GroupDialog } from './components/GroupDialog'
import { GroupMembers } from './components/GroupMembers'
import { ChangeSummary } from './components/ChangeSummary'
import { Resources } from './components/Resources'
import { useSchemaSync } from './lib/schemaStore'
import { RuleProviders } from './components/RuleProviders'
import { DirectExceptions } from './components/DirectExceptions'
import { HomeOverview } from './components/HomeOverview'
import { ProfileLibrary } from './components/ProfileLibrary'
import type { RuleProvider } from './lib/ruleProviders'
import { saveProxyYaml } from './lib/nodeYaml'
import { patchValue } from './lib/document'
import { canEditSimpleRule, ruleParts } from './lib/rules'
import { readOrder } from './lib/groupOrder'

const NodeDialog = lazy(() => import('./components/NodeDialog'))
const ConfigFieldsDialog = lazy(() => import('./components/ConfigFieldsDialog'))

const LazyDiffEditor = lazy(() => import('./components/DiffEditor'))
function DiffEditor(props: { before: string; after: string }) {
  return (
    <Suspense fallback={<div className="quiet-note">正在载入差异视图…</div>}>
      <LazyDiffEditor {...props} />
    </Suspense>
  )
}

type Page =
  | 'overview'
  | 'profiles'
  | 'nodes'
  | 'groups'
  | 'rules'
  | 'dns'
  | 'resources'
  | 'source'
  | 'runtime'
  | 'history'
type Notice = { text: string; error?: boolean }
type Dialog = {
  title: string
  body: ReactNode
  confirm: string
  danger?: boolean
  preview?: { before: string; after: string; applied?: boolean }
  error?: string
  cancel?: string
  secondary?: { label: string; action: () => void }
  action: () => void | boolean | Promise<void | boolean>
}
const pages: { id: Page; title: string; icon: LucideIcon; description: string }[] = [
  {
    id: 'overview',
    title: '首页',
    icon: LayoutDashboard,
    description: '运行状态与常用操作。',
  },
  {
    id: 'profiles',
    title: '配置管理',
    icon: Files,
    description: '管理配置文件，编辑基础设置和保存草稿。',
  },
  {
    id: 'nodes',
    title: '节点管理',
    icon: Globe2,
    description: '管理订阅和自建节点，在代理组中组合使用。',
  },
  {
    id: 'groups',
    title: '代理组',
    icon: GitBranch,
    description: '设置节点、订阅和选择策略。',
  },
  {
    id: 'rules',
    title: '分流规则',
    icon: ListFilter,
    description: '按顺序匹配规则，可调整目标和优先级。',
  },
  {
    id: 'dns',
    title: 'DNS 设置',
    icon: Network,
    description: '配置解析模式、监听地址和上游 DNS。',
  },
  {
    id: 'resources',
    title: '内核与资源',
    icon: HardDrive,
    description: '配置 GEO 来源与更新方式，查看内核和资源接入状态。',
  },
  {
    id: 'source',
    title: 'YAML 源码',
    icon: FileCode2,
    description: '编辑完整配置，查看与已应用版本的差异。',
  },
  {
    id: 'runtime',
    title: '运行面板',
    icon: Activity,
    description: '本地模拟运行状态，尚未接入 Mihomo。',
  },
  {
    id: 'history',
    title: '修订记录',
    icon: FolderClock,
    description: '查看保存记录、比较差异或恢复草稿。',
  },
]
const modeNames: Record<string, string> = { rule: '规则', global: '全局', direct: '直连' }
export default function App() {
  useSchemaSync()
  const { page: routePage } = useParams()
  const page: Page = pages.some((p) => p.id === routePage) ? (routePage as Page) : 'overview'
  const navigate = useNavigate()
  const setPage = (next: Page) => {
    void navigate(next === 'overview' ? '/' : `/${next}`)
  }
  const [state, setState] = useState<State | null>(null)
  const [text, setText] = useState('')
  const [analysis, setAnalysis] = useState<Analysis>({ config: null, errors: [], warnings: [] })
  const [parsing, setParsing] = useState(true)
  const [requestBusy, setBusy] = useState(false)
  const [coreAction, setCoreAction] = useState<CoreAction | null>(null)
  const [controlError, setControlError] = useState('')
  const busy = requestBusy || !!state?.core?.busy
  const managed = state?.simulation === false
  const [loadError, setLoadError] = useState('')
  const [coreConnectionError, setCoreConnectionError] = useState('')
  const [statusUpdatedAt, setStatusUpdatedAt] = useState('')
  const [externalDraftChanged, setExternalDraftChanged] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [nodeEdit, setNodeEdit] = useState<{ index: number; value: ProxyNode } | null>(null)
  const [configFields, setConfigFields] = useState(false)
  const [groupEdit, setGroupEdit] = useState<{ index: number; value: Group } | null>(null)
  const [ruleEdit, setRuleEdit] = useState<{ index: number; value: string } | null>(null)
  const [search, setSearch] = useState('')
  const [nodeFilter, setNodeFilter] = useState('all')
  const [sourceMode, setSourceMode] = useState<'edit' | 'diff'>('edit')
  const [mobileNav, setMobileNav] = useState(false)
  const [validation, setValidation] = useState<Diagnostic[] | null>(null)
  const [validationText, setValidationText] = useState('')
  const [historyDetail, setHistoryDetail] = useState<Revision | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const sequence = useRef(0)
  const worker = useRef<Worker | null>(null)
  const textRef = useRef(text)
  textRef.current = text
  const stateRef = useRef(state)
  stateRef.current = state
  const busyRef = useRef(requestBusy)
  busyRef.current = requestBusy
  const load = async () => {
    // Fast Refresh reruns effects. Keep the open tab's working draft intact.
    if (state) return
    try {
      const data = await api.state()
      setState(data)
      setText(data.draft)
      setLoadError('')
      setStatusUpdatedAt(new Date().toISOString())
    } catch (e) {
      setLoadError((e as Error).message)
    }
  }
  useEffect(() => {
    void load()
  }, [])
  const statusQuery = useQuery({
    queryKey: ['workspace-status'],
    queryFn: api.status,
    enabled: canPollWorkspace(state, requestBusy),
    refetchInterval: 1500,
    retry: false,
  })
  useEffect(() => {
    const status = statusQuery.data
    if (!status || busyRef.current || !stateRef.current) return
    let disposed = false
    async function synchronize() {
      const baseline = stateRef.current
      if (!baseline || !status) return
      try {
        if (disposed || busyRef.current || stateRef.current !== baseline) return
        if (status.profileID && status.profileID !== baseline.profileID) {
          setExternalDraftChanged(true)
          setCoreConnectionError('配置已在其他窗口切换，请载入最新草稿后继续操作。')
          return
        }
        // Compare against the current state, including mutation responses. A fast
        // apply can finish between polls and return the same status as before it
        // started; comparing only with the previous poll would leave busy stuck.
        const next = shouldRefreshWorkspace(baseline, status) ? await api.state() : null
        if (!disposed && !busyRef.current && stateRef.current === baseline) {
          setState((current) =>
            current
              ? next
                ? mergePolledState(current, next)
                : { ...current, metrics: status.metrics }
              : next,
          )
          setExternalDraftChanged(status.revision !== stateRef.current?.revision)
          setCoreConnectionError('')
          setStatusUpdatedAt(new Date().toISOString())
        } // Never overwrite working text.
      } catch {
        if (!disposed) setCoreConnectionError('无法读取运行状态，正在重试。编辑内容已保留。')
      }
    }
    void synchronize()
    return () => {
      disposed = true
    }
  }, [statusQuery.data, statusQuery.dataUpdatedAt])
  useEffect(() => {
    if (statusQuery.error) setCoreConnectionError('无法读取运行状态，正在重试。编辑内容已保留。')
  }, [statusQuery.error])
  useEffect(() => {
    const w = new Worker(new URL('./lib/document.worker.ts', import.meta.url), { type: 'module' })
    worker.current = w
    w.onmessage = (e) => {
      if (e.data.revision === sequence.current) {
        setAnalysis(e.data.result)
        setParsing(false)
      }
    }
    w.onerror = () => {
      w.terminate()
      if (worker.current === w) worker.current = null
      setAnalysis(analyze(textRef.current))
      setParsing(false)
    }
    return () => {
      w.terminate()
      worker.current = null
    }
  }, [])
  useEffect(() => {
    setParsing(true)
    const revision = ++sequence.current
    const id = setTimeout(() => {
      if (worker.current) worker.current.postMessage({ text, revision })
      else {
        setAnalysis(analyze(text))
        setParsing(false)
      }
    }, 90)
    return () => clearTimeout(id)
  }, [text])
  useEffect(() => {
    if (!notice) return
    const id = setTimeout(() => setNotice(null), 5000)
    return () => clearTimeout(id)
  }, [notice])
  const dirty = !!state && text !== state.draft
  const unapplied = !!state && text !== state.applied
  useEffect(() => {
    const listener = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', listener)
    return () => window.removeEventListener('beforeunload', listener)
  }, [dirty])
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busy) {
        if (nodeEdit) setNodeEdit(null)
        else if (groupEdit) setGroupEdit(null)
        else if (ruleEdit) setRuleEdit(null)
        else if (dialog) setDialog(null)
        else setMobileNav(false)
      }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [nodeEdit, groupEdit, ruleEdit, dialog, busy])
  const config = analysis.config || {}
  const nodes = Array.isArray(config.proxies) ? config.proxies : []
  const groups = Array.isArray(config['proxy-groups']) ? config['proxy-groups'] : []
  const rules = Array.isArray(config.rules) ? config.rules : []
  const providers = config['proxy-providers'] || {}
  const go = (next: Page) => {
    setPage(next)
    setSearch('')
    setMobileNav(false)
    if (next !== 'history') setHistoryDetail(null)
  }
  const fail = (e: unknown) =>
    setNotice({ text: e instanceof Error ? e.message : '操作未完成', error: true })
  const edit = (operation: (text: string) => string) => {
    try {
      if (parsing) throw new Error('正在解析草稿，请稍后再编辑。')
      const next = operation(text)
      setText(next)
      setValidation(null)
      return true
    } catch (e) {
      fail(e)
      return false
    }
  }
  const field = (path: Path, value: string | number | boolean) =>
    edit((t) => setValue(t, path, value))
  const discardChanges = () => {
    if (!state || !dirty || busy) return
    setDialog({
      title: '放弃未保存的修改？',
      body: <p>恢复到上次保存的草稿，当前未保存的修改将被丢弃。</p>,
      confirm: '放弃修改',
      danger: true,
      action: () => {
        setText(state.draft)
        setValidation(null)
        setSearch('')
        setNodeFilter('all')
        setNotice({ text: '已恢复到上次保存的草稿。' })
      },
    })
  }
  const reviewSave = (applyAfter = false) => {
    if (!state || !dirty || busy) return
    const input = text
    const revision = state.revision
    setDialog({
      title: applyAfter ? (managed ? '保存并应用前预览' : '保存并模拟应用前预览') : '保存前预览',
      body: (
        <p>
          {applyAfter
            ? managed
              ? '与内核已应用配置对比。确认后保存草稿，校验通过再重启内核；失败恢复原配置，保留新草稿便于修改。管理接口由服务固定。'
              : '确认后保存以下修改，并应用到本地模拟器。'
            : '对比上次保存的草稿，确认后写入本地。'}
        </p>
      ),
      preview: {
        before: applyAfter ? state.applied : state.draft,
        after: input,
        applied: applyAfter,
      },
      confirm: applyAfter ? (managed ? '确认保存并应用' : '确认保存并模拟应用') : '确认保存',
      cancel: '继续编辑',
      action: async () => {
        setBusy(true)
        let saved = false
        try {
          const data = await api.save(input, revision, state.profileID)
          saved = true
          setState(data)
          if (applyAfter) {
            setState(
              await api.apply(
                data.revision,
                state.core?.currentID,
                state.appliedRevision,
                state.profileID,
              ),
            )
            setNotice({
              text: managed ? '草稿已保存，正在校验并应用到内核。' : '草稿已保存并模拟应用。',
            })
          } else {
            setNotice({ text: '草稿已保存到本地，运行状态未改变。' })
          }
          return true
        } catch (e) {
          const message = e instanceof Error ? e.message : '操作未完成'
          if (saved) {
            fail(new Error('草稿已保存，但应用请求失败：' + message))
            return true
          }
          setDialog((current) => (current ? { ...current, error: message } : current))
          return false
        } finally {
          setBusy(false)
        }
      },
    })
  }
  const validate = async () => {
    setBusy(true)
    const input = text
    try {
      const data = await api.validate(input)
      if (textRef.current === input) {
        setValidation(data.diagnostics)
        setValidationText(input)
      }
      setNotice({
        text: data.valid
          ? '本地静态检查通过。尚未执行 Mihomo 内核校验。'
          : '发现配置问题，请查看检查结果。',
        error: !data.valid,
      })
      return data.valid
    } catch (e) {
      fail(e)
      return false
    } finally {
      setBusy(false)
    }
  }
  const apply = () => {
    if (dirty) {
      reviewSave(true)
      return
    }
    if (managed && state) {
      setDialog({
        title: '应用配置前预览',
        body: (
          <p>
            先执行内核校验，再重启并检查配置和代理端口。失败恢复原配置，草稿保留。现有连接会短暂中断；管理接口由服务固定。
          </p>
        ),
        preview: { before: state.applied, after: text, applied: true },
        confirm: '确认应用到内核',
        action: async () => {
          setBusy(true)
          try {
            setState(
              await api.apply(
                state.revision,
                state.core?.currentID,
                state.appliedRevision,
                state.profileID,
              ),
            )
            setNotice({ text: '正在校验并应用到内核。' })
          } catch (e) {
            fail(e)
          } finally {
            setBusy(false)
          }
        },
      })
      return
    }
    setDialog({
      title: '应用到本地模拟器',
      body: (
        <>
          <p>
            已保存的草稿将成为模拟器的启动配置。运行模式将恢复为{' '}
            <strong>{modeNames[String(config.mode)] || '规则'}</strong>。
          </p>
          <div className="callout">
            <Info size={17} />
            <span>不会启动 Mihomo、连接节点或修改系统网络。这里用于验证页面和配置流程。</span>
          </div>
        </>
      ),
      confirm: '确认模拟应用',
      preview: state ? { before: state.applied, after: text, applied: true } : undefined,
      action: async () => {
        if (!state) return
        setBusy(true)
        try {
          const data = await api.apply(state.revision, undefined, undefined, state.profileID)
          setState(data)
          setNotice({ text: '已模拟应用，运行模式已按 YAML 初始化。' })
        } catch (e) {
          fail(e)
        } finally {
          setBusy(false)
        }
      },
    })
  }
  const runtime = async (patch: Parameters<typeof api.runtime>[0]) => {
    setBusy(true)
    try {
      let next: State
      if (routerMode && 'mode' in patch) {
        const response = await apiFetch('/api/dashboard/live/configs', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: patch.mode }),
        })
        if (!response.ok) throw new Error('运行模式切换失败')
        next = await api.state()
      } else next = await api.runtime(patch, state?.profileID)
      setState((current) => (current ? mergePolledState(current, next) : next))
      setExternalDraftChanged(next.revision !== state?.revision)
      setNotice({ text: `${managed ? '运行' : '模拟'}状态已更新，YAML 草稿未改变。` })
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  const refreshStatus = async () => {
    setBusy(true)
    try {
      const next = await api.state()
      if (next.profileID !== state?.profileID) {
        setExternalDraftChanged(true)
        setCoreConnectionError('配置已在其他窗口切换，请载入最新草稿后继续操作。')
      } else {
        setState((current) => (current ? mergePolledState(current, next) : next))
        setExternalDraftChanged(next.revision !== state?.revision)
        setCoreConnectionError('')
        setStatusUpdatedAt(new Date().toISOString())
        setNotice({ text: '运行状态已刷新。' })
      }
    } catch (e) {
      setCoreConnectionError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const dashboardURL = () => '/api/dashboard/open'
  const serviceControl = (restart = false) => {
    if (!state || busy || (managed && !state.core?.controlAvailable)) return
    const action: CoreAction = restart
      ? 'restart'
      : state.core?.processState === 'running' || state.runtime.running
        ? 'stop'
        : 'start'
    const execute = async () => {
      setDialog(null)
      setCoreAction(action)
      setControlError('')
      setBusy(true)
      try {
        const next = state.core?.controlAvailable
          ? await api.coreControl(action, state.appliedRevision || '')
          : await api.runtime(
              action === 'restart' ? { restart: true } : { running: action === 'start' },
              state.profileID,
            )
        setState((current) => (current ? mergePolledState(current, next) : next))
        setCoreConnectionError('')
        setStatusUpdatedAt(new Date().toISOString())
      } catch (e) {
        setControlError(e instanceof Error ? e.message : '无法读取操作结果，请刷新状态后重试')
      } finally {
        setCoreAction(null)
        setBusy(false)
      }
    }
    if (action === 'start') {
      void execute()
      return
    }
    setDialog({
      title: restart ? '重启内核？' : '停止内核？',
      body: (
        <>
          <p>
            {managed
              ? restart
                ? '先撤销流量接管，再使用当前已应用配置重启内核，检查通过后恢复接管。连接会短暂中断；未保存或未应用的草稿不生效。'
                : '先撤销本项目的流量接管并恢复直连 DNS，再停止内核。Web 管理页面保持运行，LuCI 的开机启动设置不变。'
              : restart
                ? '使用当前已应用 YAML 重新初始化，临时运行模式和节点选择将重置。未保存或未应用的草稿不生效。'
                : '停止内核后，管理页面仍可使用。重新启动时使用当前已应用配置，不更改 LuCI 中的开机启动设置。'}
          </p>
          {!managed && (
            <p className="callout">本地预览：本次只改变模拟状态，不启动代理进程或修改电脑网络。</p>
          )}
        </>
      ),
      confirm: restart ? '确认重启' : '确认停止',
      danger: !restart,
      action: execute,
    })
  }
  const persistRuntimeMode = () => {
    if (!state || busy || managed || routerMode) return
    let input: string
    try {
      input = setValue(text, ['mode'], state.runtime.mode)
    } catch (e) {
      fail(e)
      return
    }
    setDialog({
      title: '将当前模式写入配置',
      body: <p>包含草稿中的全部更改。确认后保存并模拟应用；再次启动时将使用此模式。</p>,
      preview: { before: state.applied, after: input, applied: true },
      confirm: '确认保存并模拟应用',
      action: async () => {
        setBusy(true)
        setText(input)
        try {
          const saved = await api.save(input, state.revision, state.profileID)
          setState(saved)
          const applied = await api.apply(saved.revision, undefined, undefined, state.profileID)
          setState(applied)
          setNotice({ text: '当前模式已写入配置并模拟应用。' })
        } catch (e) {
          fail(e)
        } finally {
          setBusy(false)
        }
      },
    })
  }
  const previewProfileSwitch = async (id: string, saveCurrent?: string) => {
    if (!state || !state.profileID) return
    setBusy(true)
    try {
      const result = await api.profile(id)
      const target = result.profile
      setDialog({
        title: `切换到 ${target.name}`,
        body: (
          <>
            <p>
              当前使用 {state.profileName}
              。确认后执行本地静态检查，切换配置并初始化模拟器；失败保持原配置与运行状态。
              {!state.runtime.running && '本次操作将启动模拟器。'}
            </p>
            {saveCurrent !== undefined && (
              <details>
                <summary>同时保存当前配置的未保存修改</summary>
                <ChangeSummary before={state.draft} after={saveCurrent} />
                <DiffEditor before={state.draft} after={saveCurrent} />
              </details>
            )}
          </>
        ),
        preview: { before: state.applied, after: target.draft, applied: true },
        confirm: saveCurrent === undefined ? '确认切换' : '确认保存并切换',
        action: async () => {
          setBusy(true)
          try {
            const next = await api.switchProfile(
              id,
              result.profilesRevision,
              state.profileID!,
              state.revision,
              saveCurrent,
            )
            setState(next)
            setText(next.draft)
            setValidation(null)
            setExternalDraftChanged(false)
            setCoreConnectionError('')
            setHistoryDetail(null)
            setNotice({ text: `已切换到 ${next.profileName}，运行模式按 YAML 初始化。` })
            return true
          } catch (e) {
            setDialog((current) =>
              current ? { ...current, error: (e as Error).message } : current,
            )
            return false
          } finally {
            setBusy(false)
          }
        },
      })
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  const switchProfile = (id: string) => {
    if (!state || busy || managed || routerMode || id === state.profileID) return
    if (dirty) {
      setDialog({
        title: '当前配置有未保存修改',
        body: <p>选择保存或放弃这些修改，然后预览要切换的配置。取消会保留当前编辑内容。</p>,
        confirm: '保存修改并预览',
        secondary: { label: '放弃修改并预览', action: () => void previewProfileSwitch(id) },
        action: () => {
          void previewProfileSwitch(id, text)
          return false
        },
      })
    } else void previewProfileSwitch(id)
  }
  const exportText = () => {
    const blob = new Blob([text], { type: 'application/yaml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = state?.profileName || 'config.yaml'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setNotice({ text: '已导出当前 YAML 草稿。' })
  }
  const importFile = async (file: File) => {
    if (file.size > 2 * 1024 * 1024) {
      fail(new Error('配置文件不能超过 2 MB'))
      return
    }
    const content = await file.text()
    setDialog({
      title: '导入 YAML 配置',
      body: (
        <p>
          将 <strong>{file.name}</strong> 载入当前草稿。
          {dirty ? '当前尚未保存的修改会被替换。' : '正式配置和运行状态保持不变。'}
        </p>
      ),
      confirm: '载入草稿',
      action: () => {
        setText(content)
        setPage('source')
        setValidation(null)
        setNotice({ text: '已导入草稿，请检查后保存。' })
      },
    })
  }
  const deleteEntry = (section: 'proxies' | 'proxy-groups', index: number) => {
    const item = (config[section] as { name: string }[])[index]
    const used = references(config, item.name)
    if (used.length) {
      fail(new Error(`仍被 ${used.join('、')} 引用。请先调整引用后再删除。`))
      return
    }
    setDialog({
      title: `删除 ${item.name}？`,
      body: <p>将从当前 YAML 草稿中删除该项目。保存并应用前不会影响模拟运行状态。</p>,
      confirm: '从草稿删除',
      danger: true,
      action: () => {
        edit((t) => removeItem(t, section, index))
      },
    })
  }
  const saveNode = (source: string, index: number) => {
    if (parsing) throw new Error('正在解析草稿，请稍后再编辑。')
    setText(saveProxyYaml(text, index, source))
    setValidation(null)
    setNodeEdit(null)
  }
  const saveGroup = (value: Group, index: number) => {
    const success = edit((t) => {
      if (
        !value.proxies?.length &&
        !value.use?.length &&
        !value['include-all'] &&
        !value['include-all-proxies'] &&
        !value['include-all-providers']
      )
        throw new Error('至少选择一个节点或订阅，或启用 include-all。')
      if (index < 0) return appendItem(t, 'proxy-groups', value)
      let next = rename(t, 'proxy-groups', index, value.name)
      if (value.type !== groups[index].type)
        next = setValue(next, ['proxy-groups', index, 'type'], value.type)
      if (JSON.stringify(value.proxies || []) !== JSON.stringify(groups[index].proxies || []))
        next = setStringList(next, ['proxy-groups', index, 'proxies'], value.proxies || [])
      if (JSON.stringify(value.use || []) !== JSON.stringify(groups[index].use || []))
        next = setStringList(next, ['proxy-groups', index, 'use'], value.use || [])
      return patchValue(next, ['proxy-groups', index], value)
    })
    if (success) setGroupEdit(null)
  }
  const filteredNodes = nodes
    .map((node, index) => ({ node, index }))
    .filter(
      ({ node }) =>
        (nodeFilter === 'all' || node.type === nodeFilter) &&
        `${node.name} ${node.server} ${node.type}`.toLowerCase().includes(search.toLowerCase()),
    )
  const current = pages.find((p) => p.id === page) ?? pages[1]
  const errors = analysis.errors
  const canForm = !!analysis.config
  if (loadError && !state)
    return (
      <div className="loading-screen">
        <BrandMark />
        <h1>{routerMode ? '配置管理服务尚未就绪' : '本地服务尚未就绪'}</h1>
        <p>{loadError}</p>
        <button className="button primary" onClick={() => void load()}>
          <RefreshCw size={16} />
          重新连接
        </button>
        <small>
          {routerMode
            ? `请检查 LuCI 中的 ${APP_NAME} 总开关和 Web 端口，然后重新登录独立面板。`
            : '在项目目录运行 npm run dev，同时启动页面和 Go API。'}
        </small>
      </div>
    )
  if (!state)
    return (
      <div className="loading-screen">
        <BrandMark />
        <div className="loading-bar" />
        <p>正在打开首页…</p>
      </div>
    )

  return (
    <div className="app-shell">
      {mobileNav && (
        <button className="nav-scrim" aria-label="关闭导航" onClick={() => setMobileNav(false)} />
      )}
      <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
        <button className="brand" onClick={() => go('overview')}>
          <BrandMark />
          <div>
            <strong>{APP_NAME}</strong>
            <small>配置管理</small>
          </div>
        </button>
        <div className="workspace-switch">
          <span className="workspace-icon">
            <HardDrive size={16} />
          </span>
          <div>
            <strong>{routerMode ? '路由器配置' : '本地工作空间'}</strong>
            <small>{routerMode ? 'ImmortalWrt / OpenWrt' : 'Local workspace'}</small>
          </div>
          <Badge tone="gray">{routerMode ? 'WEB' : 'DEV'}</Badge>
        </div>
        <div className="nav-label">工作空间</div>
        <nav aria-label="主导航">
          {pages
            .filter((p) => p.id !== 'runtime' && p.id !== 'history')
            .map(({ id, title, icon: Icon }) => (
              <button
                key={id}
                className={`nav-item ${current.id === id ? 'active' : ''}`}
                onClick={() => go(id)}
              >
                <Icon size={18} />
                <span>{title}</span>
                {id === 'source' && <span className="nav-shortcut">YAML</span>}
              </button>
            ))}
        </nav>
        <div className="nav-label second">运行与记录</div>
        <nav aria-label="运行与记录">
          {pages
            .filter((p) => p.id === 'history')
            .map(({ id, title, icon: Icon }) => (
              <button
                key={id}
                className={`nav-item ${current.id === id ? 'active' : ''}`}
                onClick={() => go(id)}
              >
                <Icon size={18} />
                <span>{title}</span>
                {id === 'runtime' && <i className="nav-dot" />}
              </button>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-note">
            <div>
              <span className="status-dot" />
              <strong>
                {routerMode
                  ? state.networkEnabled
                    ? 'LAN 规则分流'
                    : '路由器配置'
                  : '本地预览环境'}
              </strong>
            </div>
            <p>
              配置保存在当前管理服务。
              <br />
              {routerMode
                ? state.networkEnabled
                  ? '国内直连，其他流量经过代理。'
                  : managed
                    ? '内核运行中，网络接管未启用。'
                    : '尚未启动内核或接管网络。'
                : managed
                  ? '配置应用到托管内核。'
                  : '首页与 Dashboard 的运行控制均为本地模拟。'}
            </p>
            <span className="version">
              v0.1.0 <span>·</span> {routerMode ? '路由器' : 'Development'}
            </span>
          </div>
          <button
            className="help-link"
            onClick={() =>
              setDialog({
                title: '使用说明',
                body: routerMode ? (
                  <p>
                    保存草稿后，点击应用到内核使配置生效。应用前执行 Mihomo 校验，重启后检查 DNS
                    和代理请求，失败恢复上一份配置。当前网络适配覆盖 br-lan 的 IPv4 TCP/UDP 和 DNS；
                    路由器自身和现有 VPN 路由保留。监听端口与网络服务配套，请保留预设值。
                  </p>
                ) : (
                  <>
                    <p>{APP_NAME} 本地预览支持 YAML 编辑、草稿保存、修订记录和模拟运行控制。</p>
                    <p>
                      所有节点为示例。当前没有安装或连接
                      Mihomo，没有接入路由器。静态检查不代表内核配置或节点连通性校验。
                    </p>
                    <p>
                      草稿保存在项目的 .local 目录；最多保留 30 条修订。源码编辑器支持 Ctrl+Z 撤销。
                    </p>
                  </>
                ),
                confirm: '知道了',
                action: () => {},
              })
            }
          >
            <CircleHelp size={16} />
            使用说明
            <ArrowRight size={14} />
          </button>
        </div>
      </aside>
      <div className={`main-shell ${page === 'overview' ? 'is-home' : ''}`}>
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="mobile-menu"
              aria-label="打开导航"
              onClick={() => setMobileNav(true)}
            >
              <Menu size={20} />
            </button>
            <span>工作空间</span>
            <ChevronRight size={13} />
            <strong>{routerMode ? '路由器配置' : '本地配置'}</strong>
          </div>
          <div className="topbar-right">
            <span className="local-address">
              <span
                className="status-dot"
                style={coreConnectionError ? { background: '#c58a3b' } : undefined}
              />
              {coreConnectionError
                ? '连接待恢复'
                : routerMode
                  ? '管理服务已连接'
                  : '本地服务已连接'}
            </span>
            <span className="top-divider" />
            <Badge tone="blue">
              {managed ? '托管内核' : routerMode ? '仅配置管理' : '模拟环境'}
            </Badge>
            <SignOut onError={fail} />
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <h1>{current.title}</h1>
              <p>
                {managed && page === 'runtime'
                  ? '托管内核的实际进程和已应用配置。'
                  : current.description}
              </p>
            </div>
            {page !== 'overview' && (
              <div className="page-actions">
                <button
                  className="button"
                  disabled={!canForm}
                  onClick={() => setConfigFields(true)}
                >
                  <Settings2 size={16} />
                  更多字段
                </button>
                <button className="button" onClick={() => fileInput.current?.click()}>
                  <Upload size={16} />
                  导入
                </button>
                <button className="button" onClick={discardChanges} disabled={busy || !dirty}>
                  <RotateCcw size={16} />
                  放弃修改
                </button>
                <button className="button" onClick={() => reviewSave()} disabled={busy || !dirty}>
                  <Save size={16} />
                  保存草稿
                </button>
                <button
                  className="button primary"
                  onClick={apply}
                  disabled={
                    (routerMode && !managed) ||
                    busy ||
                    parsing ||
                    errors.length > 0 ||
                    (managed && !state.core?.currentID)
                  }
                >
                  <Play size={15} />
                  {managed ? '应用到内核' : routerMode ? '暂未开放应用' : '模拟应用'}
                </button>
              </div>
            )}
          </div>
          <input
            type="file"
            ref={fileInput}
            hidden
            accept=".yaml,.yml,.txt"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void importFile(file)
              e.target.value = ''
            }}
          />
          {page !== 'overview' && (
            <div className="document-strip">
              <div className="document-name">
                <FileCode2 size={17} />
                <strong>{state.profileName || 'config.yaml'}</strong>
                <span className={`document-status ${dirty ? 'dirty' : ''}`}>
                  <span />
                  {dirty ? '有未保存修改' : '草稿已保存'}
                </span>
                {unapplied && (!routerMode || managed) && (
                  <span className="pending-label">{managed ? '待应用' : '待模拟应用'}</span>
                )}
              </div>
              <div className="document-meta">
                <span>{text.split('\n').length} 行</span>
                <span>UTF-8</span>
                <span>保存于 {timeLabel(state.savedAt)}</span>
                <IconButton icon={ArrowDownToLine} label="导出当前 YAML" onClick={exportText} />
              </div>
            </div>
          )}
          {externalDraftChanged && (
            <div className="error-banner" role="alert">
              <span>草稿已在其他页面保存。当前编辑内容保留；保存前请导出或载入最新草稿。</span>
              <button
                className="button small"
                disabled={busy}
                onClick={() =>
                  setDialog({
                    title: '载入最新草稿？',
                    body: <p>当前编辑内容将被替换。如需保留，请先导出。</p>,
                    confirm: '载入最新草稿',
                    action: async () => {
                      setBusy(true)
                      try {
                        const next = await api.state()
                        setState(next)
                        setText(next.draft)
                        setExternalDraftChanged(false)
                        setCoreConnectionError('')
                      } catch (e) {
                        fail(e)
                        return false
                      } finally {
                        setBusy(false)
                      }
                    },
                  })
                }
              >
                载入最新草稿
              </button>
            </div>
          )}
          {coreConnectionError && (
            <div className="error-banner" role="alert">
              {coreConnectionError}
            </div>
          )}
          {managed &&
            (state.core?.operation.kind === '应用配置' || state.applicationError) &&
            (page !== 'overview' ||
              state.core?.busy ||
              state.core?.operation.error ||
              state.applicationError) && (
              <div
                className={
                  state.core?.operation.error || state.applicationError
                    ? 'error-banner'
                    : 'simulation-banner'
                }
                role="status"
              >
                {state.applicationError ||
                  state.core?.operation.error ||
                  (state.core?.busy
                    ? `${state.core.operation.phase}…`
                    : '配置已应用，内核运行检查通过。订阅加载状态请在节点管理中查看。')}
              </div>
            )}
          {!canForm && !parsing && (
            <div className="error-banner">
              <XCircle size={18} />
              <div>
                <strong>草稿暂时无法用于表单</strong>
                <p>原始文本已保留。请修复语法或字段类型后继续表单编辑。</p>
              </div>
              <button onClick={() => go('source')}>
                查看源码 <ArrowRight size={14} />
              </button>
            </div>
          )}
          {page === 'overview' && (
            <HomeOverview
              state={state}
              dirty={dirty}
              unapplied={unapplied}
              busy={busy}
              error={
                coreConnectionError ||
                (externalDraftChanged ? '其他窗口已修改配置，请重新载入。' : '')
              }
              updatedAt={statusUpdatedAt}
              onPower={() => serviceControl()}
              onRestart={() => serviceControl(true)}
              onMode={(mode) => void runtime({ mode })}
              pendingAction={coreAction}
              controlError={controlError}
              onPersistMode={persistRuntimeMode}
              onSwitch={switchProfile}
              onEdit={() => go('source')}
              onProfiles={() => go('profiles')}
              onApply={apply}
              dashboardURL={dashboardURL}
              onRefresh={() => void refreshStatus()}
              onHistory={() => go('history')}
            />
          )}
          {page === 'profiles' && (
            <>
              <ProfileLibrary
                state={state}
                disabled={
                  busy || managed || routerMode || !!coreConnectionError || externalDraftChanged
                }
                onUpdate={(next) => {
                  setState((current) => (current ? mergePolledState(current, next) : next))
                  setNotice({ text: '配置库已更新。' })
                }}
                onSwitch={switchProfile}
                onEdit={() => go('source')}
              />
              <div className="stats-grid">
                {[
                  {
                    label: '自建节点',
                    count: nodes.length,
                    sub: '手动配置',
                    icon: Globe2,
                    page: 'nodes',
                    color: 'mint',
                  },
                  {
                    label: '代理组',
                    count: groups.length,
                    sub: '分流策略',
                    icon: GitBranch,
                    page: 'groups',
                    color: 'lavender',
                  },
                  {
                    label: '分流规则',
                    count: rules.length,
                    sub: '按顺序匹配',
                    icon: ListFilter,
                    page: 'rules',
                    color: 'blue',
                  },
                  {
                    label: '订阅',
                    count: Object.keys(providers).length,
                    sub: '节点来源',
                    icon: Rss,
                    page: 'nodes',
                    color: 'sand',
                  },
                ].map((item) => (
                  <button
                    key={item.label}
                    className="stat-card"
                    onClick={() => go(item.page as Page)}
                  >
                    <div className={`stat-icon ${item.color}`}>
                      <item.icon size={20} />
                    </div>
                    <div>
                      <span>{item.label}</span>
                      <strong className={typeof item.count === 'string' ? 'text-stat' : ''}>
                        {item.count}
                        <small>{typeof item.count === 'number' ? '个' : ''}</small>
                      </strong>
                      <p>{item.sub}</p>
                    </div>
                    <ArrowUp size={14} className="stat-arrow" />
                  </button>
                ))}
              </div>
              <div className="workspace-grid">
                <div className="form-column">
                  <Panel
                    title="基础配置"
                    description="调整启动时使用的配置，修改会同步至右侧 YAML。"
                    action={
                      <span className="subtle-icon">
                        <SlidersHorizontal size={18} />
                      </span>
                    }
                  >
                    <fieldset disabled={!canForm} className="form-body">
                      <Field
                        label="启动模式"
                        hint={
                          managed
                            ? '确认应用后，内核使用此模式启动。'
                            : routerMode
                              ? '仅保存到 YAML 草稿，当前不启动内核。'
                              : '模拟应用时恢复为此模式；运行面板的临时切换不会改写这里。'
                        }
                      >
                        <ModeControl
                          value={String(config.mode || 'rule')}
                          onChange={(value) => field(['mode'], value)}
                        />
                      </Field>
                      <div className="field-grid">
                        <Field label="混合端口" hint="HTTP 与 SOCKS 共用端口">
                          <TextField
                            value={config['mixed-port'] ?? ''}
                            label="混合端口"
                            type="number"
                            onCommit={(value) => field(['mixed-port'], Number(value))}
                          />
                        </Field>
                        <Field label="日志级别" hint="控制日志的详细程度">
                          <select
                            aria-label="日志级别"
                            value={String(config['log-level'] || 'info')}
                            onChange={(e) => field(['log-level'], e.target.value)}
                          >
                            {['debug', 'info', 'warning', 'error', 'silent'].map((v) => (
                              <option key={v} value={v}>
                                {v}
                              </option>
                            ))}
                          </select>
                        </Field>
                      </div>
                      <div className="switch-row">
                        <div>
                          <strong>允许局域网连接</strong>
                          <p>对应 allow-lan，仅编辑配置值</p>
                        </div>
                        <Switch
                          value={config['allow-lan']}
                          label="允许局域网连接"
                          onChange={(v) => field(['allow-lan'], v)}
                        />
                      </div>
                      <div className="switch-row last">
                        <div>
                          <strong>IPv6 支持</strong>
                          <p>对应 ipv6，实际接管能力尚未接入</p>
                        </div>
                        <Switch
                          value={config.ipv6}
                          label="IPv6 支持"
                          onChange={(v) => field(['ipv6'], v)}
                        />
                      </div>
                    </fieldset>
                    <div className="panel-foot">
                      <ShieldCheck size={15} />
                      未涉及的字段和注释保留在原文中
                    </div>
                  </Panel>
                  <Panel
                    title="配置检查"
                    action={
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() => void validate()}
                      >
                        <RefreshCw size={13} />
                        重新检查
                      </button>
                    }
                  >
                    <Validation
                      errors={
                        validation && validationText === text
                          ? validation.map((v) => v.message)
                          : errors
                      }
                      parsing={parsing}
                      checked={!!validation && validationText === text}
                    />
                  </Panel>
                </div>
                <Panel
                  title="YAML 实时预览"
                  description="当前草稿，只读。"
                  className="source-panel"
                  action={
                    <button className="text-button" onClick={() => go('source')}>
                      编辑源码
                      <ArrowRight size={14} />
                    </button>
                  }
                >
                  <div className="editor-filebar">
                    <span>
                      <FileCode2 size={13} />
                      config.yaml
                    </span>
                    <span className="sync-label">
                      <span />
                      已同步
                    </span>
                  </div>
                  <Editor value={text} readOnly height="500px" />
                  <div className="editor-status">
                    <span>YAML</span>
                    <span>只读预览 · 点击编辑源码开始修改</span>
                  </div>
                </Panel>
              </div>
            </>
          )}
          {current.id === 'nodes' && (
            <div className="node-management">
              <Subscriptions
                managed={managed}
                providers={providers}
                groups={groups}
                disabled={!canForm || parsing || busy}
                onEdit={edit}
                onSource={() => go('source')}
              />
              {managed && <ProviderStatus appliedRevision={state.appliedRevision} />}
              <Panel
                title={`自建节点 · ${nodes.length}`}
                description="直接编辑节点 YAML，可参考不同协议的配置示例。"
                action={
                  <button
                    className="button primary small"
                    disabled={!canForm}
                    onClick={() =>
                      setNodeEdit({
                        index: -1,
                        value: {
                          name: '',
                          type: 'vless',
                        },
                      })
                    }
                  >
                    <Plus size={15} />
                    添加节点
                  </button>
                }
              >
                <div className="table-toolbar">
                  <div className="search-input">
                    <Search size={16} />
                    <input
                      aria-label="搜索节点"
                      placeholder="搜索节点名称、地址…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                  <div className="filter-pills">
                    {['all', ...new Set(nodes.map((n) => n.type))].map((type) => (
                      <button
                        key={type}
                        className={nodeFilter === type ? 'active' : ''}
                        onClick={() => setNodeFilter(type)}
                      >
                        {type === 'all' ? '全部类型' : type.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>
                {filteredNodes.length ? (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>节点名称</th>
                          <th>协议</th>
                          <th>服务器</th>
                          <th>端口</th>
                          <th>来源</th>
                          <th className="right">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredNodes.map(({ node, index }) => (
                          <tr key={index}>
                            <td>
                              <div className="node-name">
                                <div className={`node-symbol color-${index % 4}`}>
                                  <Globe2 size={17} />
                                </div>
                                <div>
                                  <strong>{node.name}</strong>
                                  <small>
                                    {node.udp === true
                                      ? 'UDP 已启用'
                                      : node.udp === false
                                        ? 'UDP 已关闭'
                                        : '使用协议默认设置'}
                                  </small>
                                </div>
                              </div>
                            </td>
                            <td>
                              <Badge
                                tone={
                                  node.type === 'vless'
                                    ? 'blue'
                                    : node.type === 'trojan'
                                      ? 'purple'
                                      : 'gray'
                                }
                              >
                                {node.type?.toUpperCase()}
                              </Badge>
                            </td>
                            <td className="mono muted">
                              {node.server ||
                                (Array.isArray(node.peers) ? `${node.peers.length} 个 Peer` : '—')}
                            </td>
                            <td className="mono">{node.port ?? '—'}</td>
                            <td>
                              <span className="source-label">
                                <span />
                                本地配置
                              </span>
                            </td>
                            <td>
                              <div className="row-actions">
                                <IconButton
                                  icon={Pencil}
                                  label={`编辑 ${node.name}`}
                                  onClick={() => setNodeEdit({ index, value: { ...node } })}
                                />
                                <IconButton
                                  icon={Copy}
                                  label={`复制 ${node.name}`}
                                  onClick={() => {
                                    let name = `${node.name} 副本`
                                    let n = 2
                                    while (nodes.some((p) => p.name === name))
                                      name = `${node.name} 副本 ${n++}`
                                    edit((t) => appendItem(t, 'proxies', { ...node, name }))
                                  }}
                                />
                                <IconButton
                                  icon={Trash2}
                                  label={`删除 ${node.name}`}
                                  danger
                                  onClick={() => deleteEntry('proxies', index)}
                                />
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty
                    title="没有找到节点"
                    description={
                      nodes.length
                        ? '试试其他关键词或协议类型。'
                        : '添加第一个节点，或导入已有的 YAML 配置。'
                    }
                  />
                )}
                <div className="panel-foot">
                  <Info size={15} />
                  节点改名会一并更新代理组与规则引用；不会测试或连接节点。
                </div>
              </Panel>
            </div>
          )}
          {page === 'groups' && (
            <>
              <div className="section-toolbar">
                <span>共 {groups.length} 个代理组</span>
                <button
                  className="button primary"
                  disabled={!canForm}
                  onClick={() =>
                    setGroupEdit({
                      index: -1,
                      value: { name: '', type: 'select', proxies: ['DIRECT'] },
                    })
                  }
                >
                  <Plus size={16} />
                  添加代理组
                </button>
              </div>
              <div className="group-grid">
                {groups.map((group, index) => (
                  <Panel
                    key={index}
                    title={group.name}
                    description={
                      group.type === 'select'
                        ? '手动选择策略'
                        : group.type === 'url-test'
                          ? '自动延迟测试'
                          : '代理策略'
                    }
                    action={
                      <div className="row-actions">
                        <IconButton
                          icon={Pencil}
                          label={`编辑代理组 ${group.name}`}
                          onClick={() => setGroupEdit({ index, value: { ...group } })}
                        />
                        <IconButton
                          icon={Trash2}
                          label={`删除代理组 ${group.name}`}
                          danger
                          onClick={() => deleteEntry('proxy-groups', index)}
                        />
                      </div>
                    }
                  >
                    <div className="group-body">
                      <Badge tone={group.type === 'select' ? 'green' : 'purple'}>
                        {group.type}
                      </Badge>
                      {readOrder(group) && <Badge tone="gray">自定义混排</Badge>}
                      <GroupMembers
                        config={config}
                        group={group}
                        applied={analyze(state?.applied || '').config || {}}
                        appliedRevision={state?.appliedRevision}
                        managed={managed}
                        disabled={busy || parsing || !!groupEdit}
                        onChange={(value) => {
                          if (textRef.current !== text) {
                            fail(new Error('草稿已变化，请重新清理。'))
                            return
                          }
                          edit((t) => patchValue(t, ['proxy-groups', index], value))
                        }}
                      />
                      <button
                        className="add-member"
                        onClick={() => setGroupEdit({ index, value: { ...group } })}
                      >
                        <Pencil size={14} />
                        编辑成员与排序
                      </button>
                    </div>
                  </Panel>
                ))}
              </div>
              {!groups.length && (
                <Empty
                  icon={GitBranch}
                  title="还没有代理组"
                  description="创建一个策略组来组织节点。"
                />
              )}
            </>
          )}
          {page === 'rules' && (
            <div className="rules-management">
              <DirectExceptions
                config={config}
                disabled={!canForm || parsing || busy}
                onEdit={edit}
              />
              <RuleProviders
                config={config}
                disabled={!canForm || parsing || busy}
                onEdit={edit}
                onUse={(name) => setRuleEdit({ index: -1, value: `RULE-SET,${name},DIRECT` })}
                onSource={() => go('source')}
              />
              <Panel
                title={`规则列表 · ${rules.length}`}
                description="从上到下依次匹配，使用箭头调整优先级。"
                action={
                  <button
                    className="button primary small"
                    disabled={!canForm}
                    onClick={() =>
                      setRuleEdit({ index: -1, value: 'DOMAIN-SUFFIX,example.com,PROXY' })
                    }
                  >
                    <Plus size={15} />
                    添加规则
                  </button>
                }
              >
                <div className="table-toolbar">
                  <div className="search-input">
                    <Search size={16} />
                    <input
                      aria-label="搜索规则"
                      placeholder="搜索域名、IP 或策略…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                  <span className="toolbar-note">
                    <Info size={14} />
                    首条命中即生效
                  </span>
                </div>
                <div className="table-scroll">
                  <table className="rules-table">
                    <thead>
                      <tr>
                        <th className="number-column">顺序</th>
                        <th>规则类型</th>
                        <th>匹配内容</th>
                        <th>目标策略</th>
                        <th className="right">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rules
                        .map((rule, index) => ({ rule, index }))
                        .filter(({ rule }) => rule.toLowerCase().includes(search.toLowerCase()))
                        .map(({ rule, index }) => {
                          const parsed = ruleParts(rule)
                          const parts = parsed.parts
                          return (
                            <tr key={index}>
                              <td className="mono row-number">
                                {String(index + 1).padStart(2, '0')}
                              </td>
                              <td>
                                <Badge tone={parts[0] === 'MATCH' ? 'sand' : 'gray'}>
                                  {parts[0]}
                                </Badge>
                              </td>
                              <td className="mono">
                                {parts[0] === 'MATCH' ? (
                                  <span className="muted">所有剩余流量</span>
                                ) : (
                                  parsed.payload
                                )}
                              </td>
                              <td>
                                <span
                                  className={`policy-pill ${parts[0] === 'MATCH' ? 'purple' : ''}`}
                                >
                                  <GitBranch size={13} />
                                  {parsed.target}
                                </span>
                              </td>
                              <td>
                                <div className="row-actions">
                                  <IconButton
                                    icon={ArrowUp}
                                    label={`上移规则 ${index + 1}`}
                                    disabled={index === 0}
                                    onClick={() =>
                                      edit((t) => moveItem(t, 'rules', index, index - 1))
                                    }
                                  />
                                  <IconButton
                                    icon={ArrowDown}
                                    label={`下移规则 ${index + 1}`}
                                    disabled={index === rules.length - 1}
                                    onClick={() =>
                                      edit((t) => moveItem(t, 'rules', index, index + 1))
                                    }
                                  />
                                  <IconButton
                                    icon={Pencil}
                                    label={`编辑规则 ${index + 1}`}
                                    onClick={() => {
                                      if (!canEditSimpleRule(rule)) {
                                        go('source')
                                        setNotice({
                                          text: '复杂规则请在源码中编辑，避免改变匹配语义。',
                                        })
                                        return
                                      }
                                      setRuleEdit({ index, value: rule })
                                    }}
                                  />
                                  <IconButton
                                    icon={Trash2}
                                    label={`删除规则 ${index + 1}`}
                                    danger
                                    onClick={() =>
                                      setDialog({
                                        title: '删除这条规则？',
                                        body: <code className="rule-preview">{rule}</code>,
                                        confirm: '从草稿删除',
                                        danger: true,
                                        action: () => {
                                          edit((t) => removeItem(t, 'rules', index))
                                        },
                                      })
                                    }
                                  />
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                    </tbody>
                  </table>
                </div>
                {!rules.length && (
                  <Empty
                    icon={ListFilter}
                    title="还没有分流规则"
                    description="添加规则后可在这里调整匹配顺序。"
                  />
                )}
                <div className="panel-foot">
                  <ShieldCheck size={15} />
                  规则目标引用会被检查，修改前后的差异可在源码页面查看。
                </div>
              </Panel>
            </div>
          )}
          {page === 'resources' && (
            <Resources
              config={config}
              disabled={!canForm || parsing || busy}
              onEdit={edit}
              onNodes={() => go('nodes')}
              onRules={() => go('rules')}
            />
          )}
          {page === 'dns' && (
            <div className="dns-layout">
              <Panel
                title="DNS 解析"
                description="这些设置仅写入草稿，不改变本机 DNS。"
                action={<Network size={19} className="muted" />}
              >
                <fieldset className="form-body" disabled={!canForm}>
                  <div className="switch-row first">
                    <div>
                      <strong>启用 DNS</strong>
                      <p>使用 Mihomo 内置 DNS 解析服务</p>
                    </div>
                    <Switch
                      value={config.dns?.enable}
                      label="启用 DNS"
                      onChange={(v) => field(['dns', 'enable'], v)}
                    />
                  </div>
                  <Field label="解析模式">
                    <div className="option-cards">
                      {[
                        {
                          value: 'redir-host',
                          title: 'Redir Host',
                          desc: '返回真实 IP 地址',
                          icon: Globe2,
                        },
                        {
                          value: 'fake-ip',
                          title: 'Fake IP',
                          desc: '返回虚拟地址并维护映射',
                          icon: Network,
                        },
                      ].map((o) => (
                        <button
                          type="button"
                          key={o.value}
                          className={`option-card ${config.dns?.['enhanced-mode'] === o.value ? 'selected' : ''}`}
                          onClick={() => field(['dns', 'enhanced-mode'], o.value)}
                        >
                          <o.icon size={21} />
                          <strong>{o.title}</strong>
                          <small>{o.desc}</small>
                          {config.dns?.['enhanced-mode'] === o.value && <Check size={15} />}
                        </button>
                      ))}
                    </div>
                  </Field>
                  <Field label="监听地址" hint="由真实内核监听，本地原型不会占用此端口。">
                    <TextField
                      value={config.dns?.listen || ''}
                      label="DNS 监听地址"
                      onCommit={(v) => field(['dns', 'listen'], v)}
                    />
                  </Field>
                  <Field label="上游 DNS" hint="每一项对应 YAML 的 dns.nameserver。">
                    {(config.dns?.nameserver || []).map((server, index) => (
                      <div className="dns-server" key={index}>
                        <Globe2 size={16} />
                        <TextField
                          value={server}
                          label={`上游 DNS ${index + 1}`}
                          onCommit={(v) => field(['dns', 'nameserver', index], v)}
                        />
                      </div>
                    ))}
                  </Field>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setConfigFields(true)}
                  >
                    <Code2 size={14} />
                    编辑上游和更多 DNS 字段
                    <ArrowRight size={14} />
                  </button>
                </fieldset>
              </Panel>
              <div>
                <div className="info-card">
                  <div className="info-card-icon">
                    <ShieldCheck size={22} />
                  </div>
                  <h3>DNS 配置注意事项</h3>
                  <p>启动时的 DNS、节点域名解析和订阅下载需要明确的依赖关系。</p>
                  <ul>
                    <li>节点地址需要独立的解析路径</li>
                    <li>局域网域名不应发往公共上游</li>
                    <li>避免 DNS 上游再次指回自己</li>
                  </ul>
                  <span className="muted small-text">这些运行行为会在后续内核集成阶段验证。</span>
                </div>
                <Panel title="对应 YAML">
                  <Editor value={text} readOnly height="310px" />
                </Panel>
              </div>
            </div>
          )}
          {page === 'source' && (
            <>
              <div className="source-toolbar">
                <div className="tabs">
                  <button
                    className={sourceMode === 'edit' ? 'active' : ''}
                    onClick={() => setSourceMode('edit')}
                  >
                    <Code2 size={16} />
                    源码编辑
                  </button>
                  <button
                    className={sourceMode === 'diff' ? 'active' : ''}
                    onClick={() => setSourceMode('diff')}
                  >
                    <FileDiff size={16} />
                    {routerMode && !managed ? '对比初始配置' : '对比已应用配置'}
                    {unapplied && <span className="change-dot" />}
                  </button>
                </div>
                <div className="action-row source-actions">
                  <button className="button small" disabled={busy} onClick={() => void validate()}>
                    <CheckCheck size={15} />
                    检查配置
                  </button>
                  <button className="button small" onClick={exportText}>
                    <ArrowDownToLine size={15} />
                    导出
                  </button>
                  <button
                    className="button small"
                    disabled={!dirty || busy}
                    onClick={discardChanges}
                  >
                    <RotateCcw size={15} />
                    放弃修改
                  </button>
                </div>
              </div>
              <section className="panel source-full">
                {sourceMode === 'edit' ? (
                  <>
                    <div className="editor-filebar">
                      <span>
                        <FileCode2 size={14} />
                        config.yaml
                      </span>
                      <span>Ctrl + Z 撤销</span>
                    </div>
                    <Editor
                      value={text}
                      onChange={(value) => {
                        setText(value)
                        setValidation(null)
                      }}
                      height="590px"
                    />
                    <div className="editor-status">
                      <span>YAML · UTF-8</span>
                      <span>
                        {parsing
                          ? '解析中…'
                          : errors.length
                            ? `${errors.length} 个问题`
                            : '语法与基础字段检查通过'}
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="diff-labels">
                      <span>
                        {routerMode && !managed
                          ? '工作空间初始配置'
                          : managed
                            ? '内核已应用的配置'
                            : '已模拟应用的配置'}
                      </span>
                      <span>当前草稿</span>
                    </div>
                    <DiffEditor before={state.applied} after={text} />
                    {!unapplied && (
                      <div className="panel-foot">
                        <Check size={16} />
                        {routerMode && !managed
                          ? '当前草稿与初始配置一致。'
                          : '当前草稿与已应用配置一致。'}
                      </div>
                    )}
                  </>
                )}
              </section>
              <Panel title="检查结果">
                <Validation
                  errors={
                    validation && validationText === text
                      ? validation.map((v) => v.message)
                      : errors
                  }
                  parsing={parsing}
                  checked={!!validation && validationText === text}
                />
              </Panel>
            </>
          )}
          {page === 'runtime' && managed && (
            <Panel
              title="托管内核"
              description="此处显示实际进程和最后确认的配置。临时模式切换及节点选择尚未接入。"
            >
              <div className="form-body">
                <p>{state.core?.running ? '内核运行中' : '内核未运行'}</p>
                {(!routerMode || managed) && <p>最近应用：{timeLabel(state.appliedAt)}</p>}
                <p>配置版本：{state.appliedRevision?.slice(0, 12) || '未知'}</p>
                <p>{state.core?.operation.error || state.core?.operation.phase}</p>
              </div>
            </Panel>
          )}
          {page === 'runtime' && !managed && (
            <>
              <div className="simulation-banner">
                <Radio size={20} />
                <div>
                  <strong>本地运行模拟器</strong>
                  <p>用于调整交互和验证配置流程。没有真实流量、延迟或节点连接。</p>
                </div>
                <Badge tone="blue">SIMULATION</Badge>
              </div>
              <div className="runtime-grid">
                <Panel
                  title="运行状态"
                  action={
                    <Badge tone={state.runtime.running ? 'green' : 'gray'}>
                      <span className="status-dot" />
                      {state.runtime.running ? '模拟运行中' : '模拟已停止'}
                    </Badge>
                  }
                >
                  <div className="runtime-body">
                    <div className="runtime-icon">
                      <Activity size={31} />
                    </div>
                    <div>
                      <h3>Local Simulator</h3>
                      <p>真实 Mihomo 核心尚未接入</p>
                    </div>
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => void runtime({ running: !state.runtime.running })}
                    >
                      {state.runtime.running ? <Square size={14} /> : <Play size={14} />}模拟
                      {state.runtime.running ? '停止' : '启动'}
                    </button>
                  </div>
                  <div className="runtime-facts">
                    <span>
                      配置来源<strong>本地已应用修订</strong>
                    </span>
                    <span>
                      最近应用<strong>{timeLabel(state.appliedAt)}</strong>
                    </span>
                  </div>
                </Panel>
                <Panel title="临时运行模式" description="此处操作只改变模拟内存状态。">
                  <div className="form-body">
                    <ModeControl
                      value={state.runtime.mode}
                      disabled={busy || !state.runtime.running}
                      onChange={(mode) => void runtime({ mode })}
                    />
                    <div className="mode-comparison">
                      <span>
                        当前运行 <strong>{modeNames[state.runtime.mode]}</strong>
                      </span>
                      <ArrowRight size={15} />
                      <span>
                        启动配置{' '}
                        <strong>
                          {modeNames[String(analyze(state.applied).config?.mode || 'rule')]}
                        </strong>
                      </span>
                    </div>
                    <p className="muted small-text">
                      模拟启动或应用时按 YAML 恢复。刷新页面保持当前状态。
                    </p>
                  </div>
                </Panel>
              </div>
              <Panel
                title="代理组选择"
                description="仅模拟自建节点的选择。订阅节点由 Mihomo 加载，当前未接入内核。"
              >
                <div className="runtime-selections">
                  {(analyze(state.applied).config?.['proxy-groups'] || []).map((group) => (
                    <div className="runtime-selection" key={group.name}>
                      <div className="node-symbol color-0">
                        <GitBranch size={19} />
                      </div>
                      <div>
                        <strong>{group.name}</strong>
                        <small>{group.type} · 模拟选择</small>
                      </div>
                      <select
                        aria-label={`运行代理组 ${group.name}`}
                        disabled={busy || !state.runtime.running || group.type !== 'select'}
                        value={state.runtime.selected[group.name] || ''}
                        onChange={(e) =>
                          void runtime({ group: group.name, selection: e.target.value })
                        }
                      >
                        {group.proxies?.map((name) => (
                          <option key={name}>{name}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </Panel>
              <div className="quiet-note">
                <Info size={16} />
                自动测速组在原型中展示首个候选项，不模拟测速结果。
              </div>
            </>
          )}
          {page === 'history' && (
            <>
              {historyDetail ? (
                <>
                  <button className="text-button back-link" onClick={() => setHistoryDetail(null)}>
                    <ArrowLeft size={15} />
                    返回修订记录
                  </button>
                  <Panel
                    title={`修订 · ${timeLabel(historyDetail.at)}`}
                    description="左侧为历史内容，右侧为当前草稿。"
                    action={
                      <button
                        className="button primary small"
                        onClick={() =>
                          setDialog({
                            title: '将历史修订载入草稿？',
                            body: (
                              <p>
                                当前编辑内容将被替换。载入后仍需手动保存和
                                {managed ? '应用到内核' : '模拟应用'}。
                              </p>
                            ),
                            confirm: '载入草稿',
                            action: () => {
                              setText(historyDetail.text)
                              setValidation(null)
                              setHistoryDetail(null)
                              go('source')
                              setSourceMode('edit')
                            },
                          })
                        }
                      >
                        <RotateCcw size={14} />
                        载入草稿
                      </button>
                    }
                  >
                    <DiffEditor before={historyDetail.text} after={text} />
                  </Panel>
                </>
              ) : (
                <Panel
                  title="本地修订历史"
                  description="保留最近 30 次配置修订；记录仅存储于本项目。"
                >
                  <div className="history-list">
                    {state.history.map((item, index) => (
                      <button
                        className="history-row"
                        key={item.id}
                        onClick={() => setHistoryDetail(item)}
                      >
                        <div className={`history-icon ${item.kind === 'apply' ? 'applied' : ''}`}>
                          {item.kind === 'apply' ? (
                            <Play size={17} />
                          ) : item.kind === 'save' ? (
                            <Save size={17} />
                          ) : (
                            <FileCode2 size={17} />
                          )}
                        </div>
                        <div>
                          <strong>
                            {item.kind === 'core-apply'
                              ? '应用到内核'
                              : item.kind === 'apply'
                                ? '模拟应用配置'
                                : item.kind === 'save'
                                  ? '保存配置草稿'
                                  : '初始示例配置'}
                            {index === 0 && <Badge tone="gray">最新</Badge>}
                          </strong>
                          <p>
                            {timeLabel(item.at)}
                            <span>·</span>
                            {item.text.split('\n').length} 行
                          </p>
                        </div>
                        <code>{item.id.split('-')[0].slice(0, 8)}</code>
                        <span className="history-view">
                          查看差异
                          <ChevronRight size={15} />
                        </span>
                      </button>
                    ))}
                  </div>
                </Panel>
              )}
            </>
          )}
          <footer>
            <span>
              <span className="footer-dot" />
              {routerMode ? '路由器配置工作空间' : '本地配置工作空间'}
            </span>
            <span>
              {routerMode ? '独立 Web' : '本地开发'} <span className="footer-separator">/</span>{' '}
              {APP_NAME}
            </span>
          </footer>
        </main>
      </div>
      {notice && (
        <div role="status" className={`toast ${notice.error ? 'error' : ''}`}>
          {notice.error ? <XCircle size={18} /> : <CheckCheck size={18} />}
          <span>{notice.text}</span>
          <IconButton icon={X} label="关闭提示" onClick={() => setNotice(null)} />
        </div>
      )}
      {dialog && (
        <Modal
          title={dialog.title}
          size={dialog.preview ? 'wide' : 'standard'}
          onClose={() => !busy && setDialog(null)}
        >
          <Suspense fallback={<div className="dialog-body">正在加载更改预览…</div>}>
            <div className={dialog.preview ? 'save-review' : 'modal-scroll'}>
              <div className="dialog-body">{dialog.body}</div>
              {dialog.preview && (
                <>
                  <ChangeSummary before={dialog.preview.before} after={dialog.preview.after} />
                  <div className="diff-labels">
                    <span>
                      {dialog.preview.applied
                        ? managed
                          ? '内核已应用'
                          : '当前已模拟应用'
                        : '上次保存'}
                    </span>
                    <span>{dialog.preview.applied ? '待应用配置' : '本次修改'}</span>
                  </div>
                  <LazyDiffEditor before={dialog.preview.before} after={dialog.preview.after} />
                </>
              )}
            </div>
            {dialog.error && (
              <div className="save-review-error" role="alert">
                <strong>操作未完成</strong>
                <p>{dialog.error}</p>
                <p>当前修改仍保留。</p>
              </div>
            )}
            <div className="modal-actions">
              <button className="button" disabled={busy} onClick={() => setDialog(null)}>
                {dialog.cancel || '取消'}
              </button>
              {dialog.secondary && (
                <button className="button" disabled={busy} onClick={dialog.secondary.action}>
                  {dialog.secondary.label}
                </button>
              )}
              <button
                className={'button ' + (dialog.danger ? 'danger-button' : 'primary')}
                disabled={busy}
                onClick={async () => {
                  const action = dialog.action
                  const result = await action()
                  if (result !== false) setDialog(null)
                }}
              >
                {busy ? '处理中…' : dialog.confirm}
              </button>
            </div>
          </Suspense>
        </Modal>
      )}
      {configFields && (
        <Suspense fallback={<div className="quiet-note">正在载入配置字段…</div>}>
          <ConfigFieldsDialog
            config={config}
            initial={page === 'dns' ? 'dns' : 'general'}
            onClose={() => setConfigFields(false)}
            onSave={(path, value) =>
              edit((text) => {
                if (
                  path[0] === 'proxy-groups' &&
                  typeof path[1] === 'number' &&
                  typeof value.name === 'string'
                )
                  text = rename(text, 'proxy-groups', path[1], value.name)
                return patchValue(text, path, value)
              })
            }
          />
        </Suspense>
      )}
      {nodeEdit && (
        <Suspense fallback={<div className="quiet-note">正在打开节点编辑器…</div>}>
          <NodeDialog
            value={nodeEdit.value}
            text={text}
            index={nodeEdit.index}
            onClose={() => setNodeEdit(null)}
            onSave={(value) => saveNode(value, nodeEdit.index)}
          />
        </Suspense>
      )}
      {groupEdit && (
        <GroupDialog
          value={groupEdit.value}
          existing={groupEdit.index >= 0}
          config={config}
          applied={analyze(state?.applied || '').config || {}}
          appliedRevision={state?.appliedRevision}
          managed={managed}
          selection={state?.runtime.selected[groupEdit.value.name]}
          onClose={() => setGroupEdit(null)}
          onSave={(value) => saveGroup(value, groupEdit.index)}
        />
      )}
      {ruleEdit && (
        <RuleDialog
          value={ruleEdit.value}
          existing={ruleEdit.index >= 0}
          targets={['DIRECT', 'REJECT', ...groups.map((g) => g.name), ...nodes.map((n) => n.name)]}
          ruleProviders={config['rule-providers'] || {}}
          onClose={() => setRuleEdit(null)}
          onSave={(value) => {
            const success = edit((t) =>
              ruleEdit.index < 0
                ? addRule(t, value)
                : setValue(t, ['rules', ruleEdit.index], value),
            )
            if (success) setRuleEdit(null)
          }}
        />
      )}
    </div>
  )
}

function Validation({
  errors,
  parsing,
  checked,
}: {
  errors: string[]
  parsing: boolean
  checked: boolean
}) {
  return (
    <div className={`validation ${errors.length ? 'has-error' : ''}`}>
      <div className={`validation-icon ${errors.length ? 'invalid' : ''}`}>
        {errors.length ? <XCircle size={20} /> : <ShieldCheck size={20} />}
      </div>
      <div>
        <strong>
          {parsing
            ? '正在解析草稿…'
            : errors.length
              ? `发现 ${errors.length} 个配置问题`
              : checked
                ? '本地静态检查通过'
                : '草稿结构正常'}
        </strong>
        {errors.length ? (
          <ul>
            {errors.slice(0, 6).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        ) : (
          <p>
            {checked
              ? 'Go YAML 与基础引用检查完成，未执行内核校验。'
              : '语法与基础字段检查通过，尚未执行内核校验。'}
          </p>
        )}
      </div>
      {!errors.length && !parsing && <Badge>通过</Badge>}
    </div>
  )
}
function RuleDialog({
  value,
  existing,
  targets,
  ruleProviders,
  onClose,
  onSave,
}: {
  value: string
  existing: boolean
  targets: string[]
  ruleProviders: Record<string, RuleProvider>
  onClose: () => void
  onSave: (v: string) => void
}) {
  const parts = value.split(',')
  const [type, setType] = useState(parts[0])
  const [match, setMatch] = useState(parts[0] === 'MATCH' ? '' : parts[1] || '')
  const [target, setTarget] = useState(parts[0] === 'MATCH' ? parts[1] : parts[2] || 'DIRECT')
  const [noResolve, setNoResolve] = useState(parts.includes('no-resolve'))
  const result =
    type === 'MATCH'
      ? `MATCH,${target}`
      : `${type},${match},${target}${noResolve ? ',no-resolve' : ''}`
  return (
    <Modal title={existing ? '编辑分流规则' : '添加分流规则'} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          onSave(result)
        }}
      >
        <div className="modal-form">
          <Field label="规则类型">
            <select
              aria-label="规则类型"
              value={type}
              onChange={(e) => {
                setType(e.target.value)
                setNoResolve(false)
                if (e.target.value === 'RULE-SET') setMatch(Object.keys(ruleProviders)[0] || '')
                else if (type === 'RULE-SET') setMatch('')
              }}
            >
              {[
                ...new Set([
                  'DOMAIN-SUFFIX',
                  'DOMAIN',
                  'DOMAIN-KEYWORD',
                  'IP-CIDR',
                  'IP-CIDR6',
                  'GEOIP',
                  'RULE-SET',
                  'MATCH',
                  parts[0],
                ]),
              ].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </Field>
          {type === 'RULE-SET' && (
            <Field label="规则集">
              <select
                aria-label="引用规则集"
                required
                value={match}
                onChange={(e) => {
                  setMatch(e.target.value)
                  setNoResolve(false)
                }}
              >
                <option value="" disabled>
                  请选择规则集
                </option>
                {match && !Object.hasOwn(ruleProviders, match) && (
                  <option value={match} disabled>
                    {match}（不存在）
                  </option>
                )}
                {Object.keys(ruleProviders).map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </Field>
          )}
          {type !== 'MATCH' && type !== 'RULE-SET' && (
            <Field label="匹配内容">
              <input
                aria-label="规则匹配内容"
                required
                value={match}
                onChange={(e) => setMatch(e.target.value)}
                placeholder="example.com"
              />
            </Field>
          )}
          <Field label="目标策略">
            <select
              aria-label="目标策略"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              {targets.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </Field>
          {(['IP-CIDR', 'IP-CIDR6', 'GEOIP'].includes(type) ||
            (type === 'RULE-SET' && ruleProviders[match]?.behavior !== 'domain')) && (
            <label className="checkbox-line">
              <input
                type="checkbox"
                checked={noResolve}
                onChange={(e) => setNoResolve(e.target.checked)}
              />
              不触发域名解析（no-resolve）
            </label>
          )}
          <code className="rule-preview">{result}</code>
        </div>
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={type === 'RULE-SET' && !Object.hasOwn(ruleProviders, match)}
          >
            {existing ? '更新草稿' : '添加到草稿'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
