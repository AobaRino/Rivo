import { describe, expect, it } from 'vitest'
import { analyze, parse, setGeoSource, updateGeoSettings } from './document'
import { summarizeChanges } from './changes'

describe('GEO configuration edits', () => {
  const original = '# keep\r\nmode: rule # mode comment\r\nx-private: {keep: true}\r\n'
  it('adds native fields without materializing untouched defaults or altering other bytes', () => {
    expect(updateGeoSettings(original, {})).toBe(original)
    expect(updateGeoSettings(original, { 'geodata-mode': undefined })).toBe(original)
    expect(setGeoSource(original, 'asn', '')).toBe(original)
    const settings = updateGeoSettings(original, {
      'geodata-mode': true,
      'geo-auto-update': true,
      'geo-update-interval': 48,
    })
    const added = setGeoSource(settings, 'geosite', 'https://example.com/geosite.dat')
    expect(added.startsWith(original)).toBe(true)
    expect(added.replaceAll('\r\n', '')).not.toContain('\n')
    expect(analyze(added).config).toMatchObject({
      'geodata-mode': true,
      'geo-auto-update': true,
      'geo-update-interval': 48,
      'geox-url': { geosite: 'https://example.com/geosite.dat' },
    })
    expect(analyze(added).config).not.toHaveProperty('geodata-loader')
  })
  it('preserves comments and unknown source keys when updating existing scalar values', () => {
    const source =
      original +
      "geodata-mode: false # keep format note\r\ngeox-url:\r\n  geoip: 'https://old.example.com/a' # keep url note\r\n  custom: unchanged\r\n"
    let next = setGeoSource(source, 'geoip', 'https://new.example.com/b')
    next = updateGeoSettings(next, { 'geodata-mode': true })
    expect(next).toBe(
      source
        .replace('false # keep', 'true # keep')
        .replace('https://old.example.com/a', 'https://new.example.com/b'),
    )
    expect(setGeoSource(next, 'geoip', 'https://new.example.com/b')).toBe(next)
  })
  it('retains both IP source formats on mode changes and removes only selected overrides', () => {
    let next = setGeoSource(original, 'mmdb', 'https://example.com/country.mmdb')
    next = setGeoSource(next, 'geoip', 'https://example.com/geoip.dat')
    next = updateGeoSettings(next, { 'geodata-mode': true })
    expect(Object.keys(analyze(next).config!['geox-url']!)).toEqual(['mmdb', 'geoip'])
    next = setGeoSource(next, 'geoip', '')
    expect(analyze(next).config!['geox-url']).toEqual({ mmdb: 'https://example.com/country.mmdb' })
    next = setGeoSource(next, 'mmdb', '')
    next = updateGeoSettings(next, { 'geodata-mode': undefined })
    expect(next).toBe(original)
  })
  it('inserts before document end markers and handles empty mappings without touching adjacent fields', () => {
    const source = 'mode: rule\ngeox-url: {}\nx-private: keep\n...\n'
    const next = setGeoSource(source, 'asn', 'https://example.com/asn.mmdb')
    expect(analyze(next).errors).toEqual([])
    expect(next).toContain('x-private: keep\n...\n')
    expect(parse(next).toJS()['geox-url'].asn).toBe('https://example.com/asn.mmdb')
    expect(
      analyze(setGeoSource('mode: rule\n...\n', 'geoip', 'https://example.com/a')).errors,
    ).toEqual([])
  })
  it('refuses shared structures, merge inheritance and comment-losing deletions', () => {
    for (const source of [
      'base: &g {geoip: old}\ngeox-url: *g\n',
      'geox-url: &g {geoip: old}\n',
      'base: &g {geoip: old}\ngeox-url:\n  <<: *g\n',
      'base: &b {mode: rule}\n<<: *b\n',
    ]) {
      expect(() => setGeoSource(source, 'geoip', 'https://example.com/a')).toThrow(/共享|继承/)
    }
    expect(() =>
      updateGeoSettings('base: &b {geodata-mode: false}\n<<: *b\n', { 'geodata-mode': true }),
    ).toThrow('继承')
    expect(() =>
      setGeoSource('geox-url:\n  geoip: https://example.com/a # important\n', 'geoip', ''),
    ).toThrow('注释')
    expect(() =>
      updateGeoSettings('geodata-mode: true # important\n', { 'geodata-mode': undefined }),
    ).toThrow('注释')
  })
  it('supports successive source edits from an empty map and settings from an empty document', () => {
    let next = 'mode: rule\ngeox-url: {}\nx-private: keep\n'
    for (const key of ['geosite', 'geoip', 'mmdb', 'asn'] as const)
      next = setGeoSource(next, key, 'https://example.com/' + key)
    expect(Object.keys(analyze(next).config!['geox-url']!)).toHaveLength(4)
    for (const key of ['geosite', 'geoip', 'mmdb', 'asn'] as const)
      next = setGeoSource(next, key, '')
    expect(next).toBe('mode: rule\nx-private: keep\n')
    const settings = updateGeoSettings('{}\n', { 'geodata-mode': true, 'geo-auto-update': true })
    expect(analyze(settings).config).toMatchObject({
      'geodata-mode': true,
      'geo-auto-update': true,
    })
    expect(
      updateGeoSettings(settings, { 'geodata-mode': undefined, 'geo-auto-update': undefined }),
    ).toBe('{}\n')
  })
  it('rejects invalid source URLs and intervals atomically', () => {
    for (const value of [
      'not a URL',
      'file:///tmp/db',
      'javascript:alert(1)',
      'https://user:secret@example.com/a',
    ])
      expect(() => setGeoSource(original, 'geoip', value)).toThrow('HTTP(S)')
    for (const interval of [0, -1, 1.5, Infinity, NaN])
      expect(() =>
        updateGeoSettings(original, { 'geodata-mode': true, 'geo-update-interval': interval }),
      ).toThrow('正整数')
  })
})

describe('GEO save summary', () => {
  it('lists each newly added source and uses the correct format, loader and hour labels', () => {
    let next = updateGeoSettings('mode: rule\n', {
      'geodata-mode': true,
      'geodata-loader': 'standard',
      'geo-auto-update': true,
      'geo-update-interval': 48,
    })
    for (const key of ['geosite', 'geoip', 'mmdb', 'asn'] as const)
      next = setGeoSource(next, key, 'https://example.com/' + key)
    const result = summarizeChanges('mode: rule\n', next)
    expect(result.changes).toHaveLength(8)
    expect(result.changes.every((item) => item.kind === 'added')).toBe(true)
    expect(result.changes.map((item) => item.title)).toEqual(
      expect.arrayContaining([
        'GEO 来源 / GeoSite',
        'GEO 来源 / GeoIP DAT',
        'GEO 来源 / Country MMDB',
        'GEO 来源 / ASN MMDB',
      ]),
    )
    expect(result.changes.find((item) => item.title === 'GEOIP 数据格式')?.details).toEqual(['DAT'])
    expect(result.changes.find((item) => item.title === 'GEO 更新间隔')?.details).toEqual([
      '48 小时',
    ])
    expect(result.changes.find((item) => item.title === 'DAT 加载方式')?.details).toEqual([
      '标准加载',
    ])
  })
  it('reports same-host source changes without copying URL secrets into the summary', () => {
    const before =
      'geox-url:\n  geosite: https://example.com/old?token=private-old\ngeodata-mode: false\ngeo-update-interval: 24\n'
    const after =
      'geox-url:\n  geosite: https://example.com/new?token=private-new\ngeodata-mode: true\ngeo-update-interval: 48\n'
    const result = summarizeChanges(before, after)
    expect(result.changes.every((item) => item.kind === 'modified')).toBe(true)
    expect(result.changes[0].details.join()).toContain('来源地址已修改')
    expect(JSON.stringify(result)).not.toContain('private-')
    expect(result.changes.find((item) => item.title === 'GEOIP 数据格式')?.details).toEqual([
      'MMDB → DAT',
    ])
    expect(result.changes.find((item) => item.title === 'GEO 更新间隔')?.details).toEqual([
      '24 小时 → 48 小时',
    ])
  })
  it('lists removal of the final source and restores default settings explicitly', () => {
    const result = summarizeChanges(
      'geox-url:\n  geosite: https://example.com/site\ngeo-auto-update: true\n',
      '{}\n',
    )
    expect(result.changes).toContainEqual({
      kind: 'removed',
      title: 'GEO 来源 / GeoSite',
      details: ['恢复内核默认来源'],
    })
    expect(result.changes).toContainEqual({
      kind: 'removed',
      title: 'GEO 自动更新',
      details: ['原值：开启；恢复内核默认值'],
    })
  })
})
