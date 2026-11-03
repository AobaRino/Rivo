export function formatBytes(bytes: number | null | undefined, suffix = '') {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return { value: '—', unit: '' }
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const index =
    bytes > 0 ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0
  const scale = Math.max(0, index)
  return { value: (bytes / 1024 ** scale).toFixed(scale ? 1 : 0), unit: units[scale] + suffix }
}
