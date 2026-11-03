import { analyze, prependRule, setValue, removeItem, patchValue } from './document'
import { canEditSimpleRule, ruleParts } from './rules'

export const directTypes = {
  'DOMAIN-SUFFIX': '域名及子域名',
  DOMAIN: '仅此域名',
  'IP-CIDR': 'IPv4 地址或网段',
  'IP-CIDR6': 'IPv6 地址或网段',
} as const
export type DirectType = keyof typeof directTypes

export function directException(value: string) {
  const rule = ruleParts(value)
  return Object.hasOwn(directTypes, rule.type) &&
    rule.target === 'DIRECT' &&
    canEditSimpleRule(value)
    ? {
        type: rule.type as DirectType,
        match: rule.payload,
        noResolve: rule.parts.includes('no-resolve'),
      }
    : null
}

export function makeDirectException(type: DirectType, input: string, noResolve = false) {
  if (!Object.hasOwn(directTypes, type)) throw new Error('请选择例外类型。')
  let value = input.trim()
  if (!value || /[\s,?#@]/.test(value))
    throw new Error('填写域名、IP 或网段，不要包含空格、端口或 URL。')
  if (type === 'DOMAIN' || type === 'DOMAIN-SUFFIX') {
    if (type === 'DOMAIN-SUFFIX') value = value.replace(/^\*\./, '')
    if (/[/:*]/.test(value))
      throw new Error('请只填写域名；通配形式 *.example.com 请选择“域名及子域名”。')
    try {
      value = new URL(`http://${value}`).hostname.toLowerCase().replace(/\.$/, '')
    } catch {
      throw new Error('域名格式不正确。')
    }
    if (
      value.length > 253 ||
      !value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
      /^[\d.]+$/.test(value)
    )
      throw new Error('域名格式不正确；IP 地址请选择对应的 IP 类型。')
    return `${type},${value},DIRECT`
  }
  const parts = value.split('/')
  if (parts.length > 2) throw new Error('网段格式不正确，例如 192.168.1.0/24。')
  let address = parts[0]
  const bits = type === 'IP-CIDR' ? 32 : 128
  if (type === 'IP-CIDR') {
    if (
      !/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(address) ||
      address.split('.').some((n) => Number(n) > 255)
    )
      throw new Error('IPv4 地址格式不正确。')
  } else {
    if (!address.includes(':') || /[%\[\]]/.test(address))
      throw new Error('IPv6 地址格式不正确，不需要方括号或接口名。')
    try {
      address = new URL(`http://[${address}]/`).hostname.slice(1, -1)
    } catch {
      throw new Error('IPv6 地址格式不正确。')
    }
  }
  if (parts[1] !== undefined && (!/^\d{1,3}$/.test(parts[1]) || Number(parts[1]) > bits))
    throw new Error(`网段前缀长度应为 0–${bits}。`)
  const prefix = parts[1] === undefined ? bits : Number(parts[1])
  return `${type},${address}/${prefix},DIRECT${noResolve ? ',no-resolve' : ''}`
}

export function saveDirectException(
  text: string,
  original: { index: number; value: string } | null,
  rule: string,
) {
  const rules = analyze(text).config?.rules || []
  if (!directException(rule)) throw new Error('直连例外格式不正确。')
  if (original && rules[original.index] !== original.value)
    throw new Error('这条规则已经变化，请重新打开编辑。')
  if (
    rules.some(
      (value, index) => index !== original?.index && value.toLowerCase() === rule.toLowerCase(),
    )
  )
    throw new Error('相同的直连例外已存在。')
  return original ? setValue(text, ['rules', original.index], rule) : prependRule(text, rule)
}

export function deleteDirectException(text: string, index: number, expected: string) {
  const rules = analyze(text).config?.rules || []
  if (rules[index] !== expected || !directException(expected))
    throw new Error('这条规则已经变化，请重新打开列表。')
  return rules.length === 1 ? patchValue(text, ['rules'], []) : removeItem(text, 'rules', index)
}
