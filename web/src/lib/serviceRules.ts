import catalog from '../../../rules/catalog.json'

// Category choices reference Aethersailor/Custom_OpenClash_Rules; all data URLs
// originate in MetaCubeX/meta-rules-dat. Lower priority values match first.
export type ServiceRule = {
  id: keyof typeof catalog.services
  name: string
  category: string
  description: string
  domains: string[]
  ips?: string[]
  directDomains?: string[]
  priority: number
  direct?: boolean
  common?: boolean
}

const choices: Omit<ServiceRule, 'domains' | 'directDomains' | 'ips'>[] = [
  {
    id: 'steam',
    name: 'Steam',
    category: '游戏',
    description: '国内下载优先直连，其余平台域名使用本组',
    priority: 20,
    common: true,
  },
  {
    id: 'games',
    name: '游戏平台',
    category: '游戏',
    description: '国内游戏及平台下载优先直连；不等同于所有游戏联机流量',
    priority: 80,
  },
  {
    id: 'microsoft',
    name: '微软服务',
    category: '办公与系统',
    description: '国内服务及收录的更新下载域名优先直连',
    priority: 80,
    direct: true,
    common: true,
  },
  {
    id: 'onedrive',
    name: 'OneDrive',
    category: '办公与系统',
    description: '独立选择云盘出口，优先于微软服务匹配',
    priority: 20,
    direct: true,
    common: true,
  },
  {
    id: 'apple',
    name: 'Apple',
    category: '办公与系统',
    description: '国内 Apple 服务优先直连',
    priority: 80,
    direct: true,
    common: true,
  },
  {
    id: 'openai',
    name: 'ChatGPT',
    category: 'AI',
    description: 'OpenAI 服务',
    priority: 10,
    common: true,
  },
  {
    id: 'claude',
    name: 'Claude',
    category: 'AI',
    description: 'Anthropic 服务',
    priority: 10,
    common: true,
  },
  {
    id: 'gemini',
    name: 'Gemini',
    category: 'AI',
    description: '优先于 Google 大分类匹配',
    priority: 10,
    common: true,
  },
  {
    id: 'copilot',
    name: 'Bing / Copilot',
    category: 'AI',
    description: '使用 Bing 分类，也会影响 Bing 搜索',
    priority: 10,
  },
  {
    id: 'grok',
    name: 'Grok',
    category: 'AI',
    description: 'xAI 服务',
    priority: 10,
  },
  {
    id: 'ai',
    name: '其他国外 AI',
    category: 'AI',
    description: '已单独勾选的 AI 服务优先使用各自分组',
    priority: 60,
  },
  {
    id: 'youtube',
    name: 'YouTube',
    category: '流媒体',
    description: '优先于 Google 大分类匹配',
    priority: 20,
    common: true,
  },
  {
    id: 'netflix',
    name: 'Netflix',
    category: '流媒体',
    description: '域名及服务 IP',
    priority: 20,
    common: true,
  },
  {
    id: 'disney',
    name: 'Disney+',
    category: '流媒体',
    description: 'Disney 流媒体服务',
    priority: 20,
  },
  {
    id: 'spotify',
    name: 'Spotify',
    category: '流媒体',
    description: '音乐与播客服务',
    priority: 20,
  },
  {
    id: 'appletv',
    name: 'Apple TV+',
    category: '流媒体',
    description: '优先于 Apple 大分类匹配',
    priority: 20,
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    category: '流媒体',
    description: 'TikTok 服务',
    priority: 20,
  },
  {
    id: 'telegram',
    name: 'Telegram',
    category: '通讯与网络',
    description: '域名及服务 IP',
    priority: 20,
    common: true,
  },
  {
    id: 'discord',
    name: 'Discord',
    category: '通讯与网络',
    description: '聊天与语音服务',
    priority: 20,
  },
  {
    id: 'google',
    name: 'Google',
    category: '通讯与网络',
    description: 'Gemini、YouTube 启用后优先使用各自分组',
    priority: 80,
  },
  {
    id: 'github',
    name: 'GitHub',
    category: '开发',
    description: '代码托管与相关服务',
    priority: 20,
    common: true,
  },
  {
    id: 'docker',
    name: 'Docker / 容器',
    category: '开发',
    description: 'Docker 及容器镜像服务',
    priority: 20,
    common: true,
  },
  {
    id: 'developer',
    name: '其他开发者服务',
    category: '开发',
    description: 'GitHub、容器服务启用后优先使用各自分组',
    priority: 80,
  },
]

export const serviceRules: ServiceRule[] = choices.map((service) => ({
  ...service,
  ...catalog.services[service.id],
}))

export type ServiceSelections = Record<string, string>
export const serviceMarker = 'x-manager-service'
export const serviceOwner = (id: string) => `metacubex:${id}`
export function ownedService(value: Record<string, unknown>) {
  return serviceRules.find((service) => value[serviceMarker] === serviceOwner(service.id))
}

export type ServiceProvider = {
  name: string
  label: string
  file: string
  behavior: 'domain' | 'ipcidr'
  direct: boolean
  service: string
}

export function serviceProviders(service: ServiceRule): ServiceProvider[] {
  const entries = (files: string[], kind: 'domain' | 'ip' | 'direct') =>
    files.map((file, i) => ({
      name: `metacubex-${kind}-${service.id}${i ? `-${i + 1}` : ''}`,
      label: `${service.name}${kind === 'direct' ? ' · 优先直连' : kind === 'ip' ? ' · IP' : ''}${i ? ` · ${file}` : ''}`,
      file: `${kind === 'ip' ? 'geoip' : 'geosite'}/${file}`,
      behavior: kind === 'ip' ? ('ipcidr' as const) : ('domain' as const),
      direct: kind === 'direct',
      service: service.id,
    }))
  return [
    ...entries(service.directDomains || [], 'direct'),
    ...entries(service.domains, 'domain'),
    ...entries(service.ips || [], 'ip'),
  ]
}
