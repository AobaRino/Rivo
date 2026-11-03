import type { Config, Path } from './document'
import { ruleRows } from './rules'

export type RuleProvider = {
  type: 'http' | 'file' | 'inline'
  behavior: 'domain' | 'ipcidr' | 'classical'
  format?: 'yaml' | 'text' | 'mrs'
  url?: string
  path?: string
  interval?: number
  payload?: string[]
  [key: string]: unknown
}
export const behaviorNames = { domain: '域名', ipcidr: 'IP 网段', classical: '经典规则' }
export const providerTypeNames = { http: 'HTTP', file: '本地文件', inline: '内联内容' }

export function ruleProviderErrors(provider: RuleProvider): string[] {
  const errors: string[] = []
  if (!['http', 'file', 'inline'].includes(provider.type)) errors.push('来源类型无效')
  if (!Object.hasOwn(behaviorNames, provider.behavior)) errors.push('请选择规则行为')
  if (provider.format !== undefined && !['yaml', 'text', 'mrs'].includes(provider.format))
    errors.push('数据格式无效')
  if (provider.format === 'mrs' && provider.behavior === 'classical')
    errors.push('MRS 格式仅支持 domain 或 ipcidr')
  if (provider.type === 'http') {
    try {
      const url = new URL(provider.url || '')
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error()
    } catch {
      errors.push('来源地址必须为 HTTP(S)，不支持 URL 用户信息')
    }
  }
  if (
    provider.interval !== undefined &&
    (!Number.isSafeInteger(provider.interval) || provider.interval < 0)
  )
    errors.push('更新间隔必须为非负整数（秒）')
  if (provider.path !== undefined && (typeof provider.path !== 'string' || !provider.path.trim()))
    errors.push('文件路径不能为空')
  if (provider.type === 'file' && !provider.path) errors.push('本地文件来源需要填写文件路径')
  if (
    provider.type === 'inline' &&
    (!Array.isArray(provider.payload) ||
      provider.payload.some((v) => typeof v !== 'string' || !v.trim()))
  )
    errors.push('内联内容必须为规则列表')
  return errors
}

export type RuleProviderReference = { path: Path; label: string; value: string; editable: boolean }
// Only plain RULE-SET rules are rewritten. Other consumers are reported and require source editing.
export function ruleProviderReferences(config: Config, name: string): RuleProviderReference[] {
  const result: RuleProviderReference[] = []
  const active = new WeakSet<object>()
  const check = (value: string, path: Path, key = false) => {
    const tokens = [...value.matchAll(/(?:^|[,(])\s*RULE-SET\s*,\s*([^,()]+)/g)]
    const prefixNames = value.startsWith('rule-set:')
      ? value
          .slice(9)
          .split(',')
          .map((s) => s.trim())
      : []
    const tunSet =
      path.some((part) => part === 'route-address-set' || part === 'route-exclude-address-set') &&
      value === name
    if (!tokens.some((m) => m[1].trim() === name) && !prefixNames.includes(name) && !tunSet) return
    const ordinary =
      (path[0] === 'rules' && path.length === 2) || (path[0] === 'sub-rules' && path.length === 3)
    const editable = !key && ordinary && /^RULE-SET\s*,[^,]+,[^,]+(?:,no-resolve)?$/.test(value)
    const label =
      path[0] === 'rules' && path.length === 2 ? `规则 ${Number(path[1]) + 1}` : path.join(' / ')
    result.push({ path, label, value, editable })
  }
  const visit = (value: unknown, path: Path, depth: number) => {
    if (depth > 64) {
      result.push({ path, label: '深层配置（请在源码中检查引用）', value: '', editable: false })
      return
    }
    if (typeof value === 'string') {
      check(value, path)
      return
    }
    if (!value || typeof value !== 'object' || active.has(value)) return
    active.add(value)
    if (Array.isArray(value)) value.forEach((item, i) => visit(item, [...path, i], depth + 1))
    else
      for (const [key, item] of Object.entries(value)) {
        check(key, [...path, key], true)
        visit(item, [...path, key], depth + 1)
      }
    active.delete(value)
  }
  visit(config, [], 0)
  return result
}

export function validateRuleProviders(config: Config): string[] {
  const errors: string[] = []
  const providers = config['rule-providers'] || {}
  const paths = new Map<string, string>()
  for (const [name, provider] of Object.entries(providers)) {
    errors.push(...ruleProviderErrors(provider).map((error) => `规则集 ${name}：${error}`))
    if (provider.path) {
      const normalized = provider.path
        .replace(/\\/g, '/')
        .split('/')
        .reduce<string[]>((parts, part) => {
          if (part === '.' || (part === '' && parts.length)) return parts
          if (part === '..' && parts.length && parts.at(-1) !== '..' && parts.at(-1) !== '')
            parts.pop()
          else parts.push(part)
          return parts
        }, [])
        .join('/')
      if (paths.has(normalized))
        errors.push(`规则集 ${name} 与 ${paths.get(normalized)} 使用相同文件路径`)
      paths.set(normalized, name)
    }
  }
  for (const row of ruleRows(config)) {
    for (const match of row.value.matchAll(/(?:^|[,(])\s*RULE-SET\s*,\s*([^,()]+)/g))
      if (!Object.hasOwn(providers, match[1].trim()))
        errors.push(`${row.label}引用了不存在的规则集：${match[1].trim()}`)
  }
  return errors
}
