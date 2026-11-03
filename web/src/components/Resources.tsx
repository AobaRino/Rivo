import { useState } from 'react'
import { Database, Pencil, RefreshCw } from 'lucide-react'
import { CoreManager } from './CoreManager'
import { DashboardManager } from './DashboardManager'
import { setGeoSource, updateGeoSettings } from '../lib/document'
import type { Config, GeoSettings, GeoSource } from '../lib/document'
import { Modal } from './Modal'
import './resources.css'

type Props = {
  config: Config
  disabled: boolean
  onEdit: (fn: (text: string) => string) => boolean
  onNodes: () => void
  onRules: () => void
}
const sources: { key: GeoSource; name: string; description: string }[] = [
  { key: 'geosite', name: 'GeoSite', description: '域名分类数据 · geosite.dat' },
  { key: 'geoip', name: 'GeoIP DAT', description: 'IP 分类数据 · geoip.dat' },
  { key: 'mmdb', name: 'Country MMDB', description: 'IP 国家数据库 · country.mmdb' },
  { key: 'asn', name: 'ASN MMDB', description: '自治系统数据库 · ASN.mmdb' },
]
const origin = (value: string) => {
  try {
    return new URL(value).host
  } catch {
    return '自定义来源'
  }
}

export function Resources({ config, disabled, onEdit, onNodes, onRules }: Props) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [source, setSource] = useState<GeoSource | null>(null)
  const dat = config['geodata-mode'] ?? false
  const auto = config['geo-auto-update'] ?? false
  const loader = config['geodata-loader'] ?? 'memconservative'
  const defaults = (key: keyof GeoSettings) => (config[key] === undefined ? '内核默认' : '已配置')
  return (
    <div className="resources-page">
      <CoreManager />
      <DashboardManager />

      <section className="panel" aria-labelledby="geo-heading">
        <div className="panel-heading">
          <div>
            <h2 id="geo-heading">GEO 设置</h2>
            <p>编辑后写入当前草稿，通过页面右上角保存。</p>
          </div>
          <button
            className="button small"
            disabled={disabled}
            onClick={() => setSettingsOpen(true)}
          >
            <Pencil size={14} />
            编辑 GEO 设置
          </button>
        </div>
        <dl className="geo-settings">
          <div>
            <dt>GEOIP 数据格式</dt>
            <dd>
              {dat ? 'DAT' : 'MMDB'}
              <small>{defaults('geodata-mode')}</small>
            </dd>
          </div>
          <div>
            <dt>DAT 加载方式</dt>
            <dd>
              {loader === 'standard' ? '标准加载' : '节省内存'}
              <small>{defaults('geodata-loader')}</small>
            </dd>
          </div>
          <div>
            <dt>GEO 自动更新</dt>
            <dd>
              {auto ? '开启' : '关闭'}
              <small>{defaults('geo-auto-update')}</small>
            </dd>
          </div>
          <div>
            <dt>更新间隔</dt>
            <dd>
              {config['geo-update-interval'] ?? 24} 小时
              <small>
                {defaults('geo-update-interval')}
                {!auto && ' · 自动更新关闭时不执行'}
              </small>
            </dd>
          </div>
        </dl>
        <p className="resource-note">
          自动更新配置由 Mihomo 执行。当前页面不下载文件，也不执行定时任务。
        </p>
      </section>

      <section className="panel" aria-labelledby="geo-sources-heading">
        <div className="panel-heading">
          <div>
            <h2 id="geo-sources-heading">GEO 数据来源</h2>
            <p>未指定来源时由内核选择默认地址，文件按配置需要使用。</p>
          </div>
          <button className="button small" disabled>
            <RefreshCw size={14} />
            更新 GEO 数据
          </button>
        </div>
        <div className="geo-source-list">
          {sources.map((item) => {
            const value = config['geox-url']?.[item.key]
            const alternate = (item.key === 'geoip' && !dat) || (item.key === 'mmdb' && dat)
            return (
              <article className="geo-source" key={item.key} aria-label={item.name}>
                <Database size={20} strokeWidth={1.5} />
                <div className="geo-source-info">
                  <div className="geo-source-title">
                    <h3>{item.name}</h3>
                    {alternate && <span className="badge gray">备用格式</span>}
                  </div>
                  <p>{item.description}</p>
                  <p className="geo-origin">
                    {value ? `自定义来源 · ${origin(value)}` : '使用内核默认来源'}
                  </p>
                </div>
                <div className="geo-source-status">
                  <span>本地文件状态未知</span>
                  <small>接入内核后可查看</small>
                </div>
                <button
                  className="button small"
                  aria-label={'编辑 ' + item.name + ' 来源'}
                  disabled={disabled}
                  onClick={() => setSource(item.key)}
                >
                  编辑来源
                </button>
              </article>
            )
          })}
        </div>
        <p className="resource-note">
          切换 GEOIP 格式会保留两种来源。恢复默认会移除该项自定义来源，不会删除文件。
        </p>
      </section>

      <section className="panel" aria-labelledby="provider-resource-heading">
        <div className="panel-heading">
          <div>
            <h2 id="provider-resource-heading">订阅与规则资源</h2>
            <p>使用各自 provider 的来源和更新间隔，不受 GEO 更新设置控制。</p>
          </div>
        </div>
        <div className="provider-resource-links">
          <div>
            <strong>节点订阅 · {Object.keys(config['proxy-providers'] || {}).length}</strong>
            <p>由 Mihomo 下载、更新和缓存。</p>
            <button className="text-button" onClick={onNodes}>
              管理订阅 →
            </button>
          </div>
          <div>
            <strong>规则集合 · {Object.keys(config['rule-providers'] || {}).length}</strong>
            <p>管理来源、规则行为、格式和更新间隔。</p>
            <button className="text-button" onClick={onRules}>
              管理规则集 →
            </button>
            <button className="text-button" onClick={onRules}>
              查看分流规则 →
            </button>
          </div>
        </div>
      </section>

      {settingsOpen && (
        <GeoSettingsDialog
          config={config}
          disabled={disabled}
          onClose={() => setSettingsOpen(false)}
          onSave={(changes) => {
            if (onEdit((text) => updateGeoSettings(text, changes))) setSettingsOpen(false)
          }}
        />
      )}
      {source && (
        <GeoSourceDialog
          name={sources.find((item) => item.key === source)!.name}
          value={config['geox-url']?.[source] || ''}
          disabled={disabled}
          onClose={() => setSource(null)}
          onSave={(value) => {
            if (onEdit((text) => setGeoSource(text, source, value))) setSource(null)
          }}
        />
      )}
    </div>
  )
}

function GeoSettingsDialog({
  config,
  disabled,
  onClose,
  onSave,
}: {
  config: Config
  disabled: boolean
  onClose: () => void
  onSave: (value: GeoSettings) => void
}) {
  const [mode, setMode] = useState(
    config['geodata-mode'] === undefined ? '' : String(config['geodata-mode']),
  )
  const [loader, setLoader] = useState(config['geodata-loader'] || '')
  const [auto, setAuto] = useState(
    config['geo-auto-update'] === undefined ? '' : String(config['geo-auto-update']),
  )
  const [interval, setInterval] = useState(config['geo-update-interval']?.toString() || '')
  return (
    <Modal title="编辑 GEO 设置" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          onSave({
            'geodata-mode': mode === '' ? undefined : mode === 'true',
            'geodata-loader': loader === '' ? undefined : (loader as GeoSettings['geodata-loader']),
            'geo-auto-update': auto === '' ? undefined : auto === 'true',
            'geo-update-interval': interval === '' ? undefined : Number(interval),
          })
        }}
      >
        <fieldset className="modal-form resource-form" disabled={disabled}>
          <label className="field">
            <span>GEOIP 数据格式</span>
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="">内核默认（MMDB）</option>
              <option value="false">MMDB</option>
              <option value="true">DAT</option>
            </select>
            <small>决定 GEOIP 规则使用的数据库格式。</small>
          </label>
          <label className="field">
            <span>DAT 加载方式</span>
            <select value={loader} onChange={(e) => setLoader(e.target.value)}>
              <option value="">内核默认（节省内存）</option>
              <option value="memconservative">节省内存</option>
              <option value="standard">标准加载</option>
            </select>
            <small>用于 DAT 数据，包括 GeoSite。</small>
          </label>
          <label className="field">
            <span>GEO 自动更新</span>
            <select value={auto} onChange={(e) => setAuto(e.target.value)}>
              <option value="">内核默认（关闭）</option>
              <option value="true">开启</option>
              <option value="false">关闭</option>
            </select>
          </label>
          <label className="field">
            <span>更新间隔（小时）</span>
            <input
              type="number"
              min="1"
              step="1"
              value={interval}
              placeholder="内核默认：24"
              onChange={(e) => setInterval(e.target.value)}
            />
            <small>留空使用内核默认值。自动更新关闭时保留配置，停止定时更新。</small>
          </label>
          <p className="resource-note">选择“内核默认”会移除对应 YAML 字段。此处确认仅更新草稿。</p>
        </fieldset>
        <div className="modal-actions">
          <button className="button" type="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" type="submit" disabled={disabled}>
            更新草稿
          </button>
        </div>
      </form>
    </Modal>
  )
}

function GeoSourceDialog({
  name,
  value,
  disabled,
  onClose,
  onSave,
}: {
  name: string
  value: string
  disabled: boolean
  onClose: () => void
  onSave: (value: string) => void
}) {
  const [url, setUrl] = useState(value)
  return (
    <Modal title={'编辑 ' + name + ' 来源'} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          onSave(url)
        }}
      >
        <fieldset className="modal-form resource-form" disabled={disabled}>
          <label className="field">
            <span>数据来源地址</span>
            <input
              type="url"
              autoComplete="off"
              spellCheck={false}
              value={url}
              placeholder="留空使用内核默认来源"
              onChange={(e) => setUrl(e.target.value)}
            />
            <small>填写对应格式文件的 HTTP(S) 地址。当前仅保存地址，不会发起下载。</small>
          </label>
          <button type="button" className="text-button" onClick={() => setUrl('')}>
            使用内核默认来源
          </button>
          {!url.trim() && <p className="resource-note">更新草稿后将移除此项自定义来源。</p>}
        </fieldset>
        <div className="modal-actions">
          <button className="button" type="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" type="submit" disabled={disabled}>
            更新草稿
          </button>
        </div>
      </form>
    </Modal>
  )
}
