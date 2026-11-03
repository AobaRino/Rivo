import { useSyncExternalStore } from 'react'
import { Moon, Sun } from 'lucide-react'
import { IconButton } from '../components/WorkspacePrimitives'

export type Appearance = 'light' | 'dark'
const storageKey = 'rivo-appearance'
let appearance: Appearance = 'light'
let preference: Appearance | null = null
let media: MediaQueryList | undefined
let initialized = false
const listeners = new Set<() => void>()

function parsePreference(value: string | null): Appearance | null {
  return value === 'light' || value === 'dark' ? value : null
}

function applyAppearance() {
  const next = preference ?? (media?.matches ? 'dark' : 'light')
  document.documentElement.dataset.theme = next
  document.documentElement.style.colorScheme = next
  document.documentElement.style.removeProperty('background-color')
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', next === 'dark' ? '#121817' : '#f4f6f5')
  if (appearance === next) return
  appearance = next
  listeners.forEach((listener) => listener())
}

function onSystemChange() {
  if (preference === null) applyAppearance()
}

function onStorage(event: StorageEvent) {
  if (event.key !== storageKey && event.key !== null) return
  preference = parsePreference(event.newValue)
  applyAppearance()
}

// Run before React renders; index.html applies the same preference before bundle loading.
export function initializeAppearance() {
  if (initialized || typeof window === 'undefined') return
  initialized = true
  try {
    preference = parsePreference(window.localStorage.getItem(storageKey))
  } catch {
    // The current tab can still switch themes when browser storage is disabled.
  }
  media = window.matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener('change', onSystemChange)
  window.addEventListener('storage', onStorage)
  applyAppearance()
}

export const getAppearance = () => appearance
function subscribeAppearance(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export const useAppearance = () =>
  useSyncExternalStore(subscribeAppearance, getAppearance, () => 'light' as const)

function toggleAppearance() {
  preference = appearance === 'dark' ? 'light' : 'dark'
  try {
    window.localStorage.setItem(storageKey, preference)
  } catch {
    // Keep the explicit choice for this tab even when it cannot be persisted.
  }
  applyAppearance()
}

export function AppearanceToggle() {
  const current = useAppearance()
  return (
    <IconButton
      icon={current === 'dark' ? Sun : Moon}
      label={current === 'dark' ? '切换为浅色主题' : '切换为深色主题'}
      onClick={toggleAppearance}
      outlined
    />
  )
}

if (import.meta.hot)
  import.meta.hot.dispose(() => {
    media?.removeEventListener('change', onSystemChange)
    window.removeEventListener('storage', onStorage)
  })
