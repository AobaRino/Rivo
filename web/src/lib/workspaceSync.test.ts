import { describe, expect, it } from 'vitest'
import {
  canPollWorkspace,
  mergePolledState,
  shouldRefreshWorkspace,
  workspaceStatusKey,
} from './workspaceSync'
import type { State } from './api'
const state: State = {
  draft: 'mode: rule\n',
  applied: 'mode: rule\n',
  revision: 'original',
  savedAt: 'first',
  appliedAt: '',
  history: [],
  simulation: false,
  runtime: { mode: 'rule', logLevel: 'info', running: true, selected: {} },
}
describe('workspace background synchronization', () => {
  it('refreshes after a fast apply even when consecutive polls both report success', () => {
    const before = {
      ...state,
      core: {
        currentID: 'router',
        busy: false,
        running: true,
        operation: { kind: 'apply', phase: 'done', status: 'success' },
      },
    }
    const mutation = {
      ...before,
      core: {
        ...before.core,
        busy: true,
        operation: { ...before.core.operation, status: 'running' },
      },
    }
    const after = { ...before }
    expect(workspaceStatusKey(before)).toBe(workspaceStatusKey(after))
    expect(shouldRefreshWorkspace(mutation, after)).toBe(true)
    expect(shouldRefreshWorkspace(after, after)).toBe(false)
  })
  it('keeps polling an asynchronous apply job while blocking conflicting requests', () => {
    const applying = {
      ...state,
      core: {
        currentID: 'router',
        busy: true,
        running: true,
        operation: { kind: 'apply', phase: 'validate', status: 'running' },
      },
    }
    expect(canPollWorkspace(applying, false)).toBe(true)
    expect(canPollWorkspace(applying, true)).toBe(false)
    expect(canPollWorkspace(null, false)).toBe(false)
    const finished = {
      ...applying,
      core: {
        ...applying.core,
        busy: false,
        operation: { ...applying.core.operation, status: 'success' },
      },
    }
    expect(workspaceStatusKey(applying)).not.toBe(workspaceStatusKey(finished))
    expect(mergePolledState(applying, finished).core?.busy).toBe(false)
  })
  it('does not refetch YAML and history on each metric sample', () => {
    const incoming = {
      ...state,
      metrics: {
        available: true,
        connections: 20,
        downloadRate: 1024,
        uploadRate: 42,
        memory: 2048,
      },
    }
    expect(workspaceStatusKey(state)).toBe(workspaceStatusKey(incoming))
  })
  it('keeps the original If-Match after another page saves', () => {
    const next = mergePolledState(state, {
      ...state,
      draft: 'mode: global\n',
      revision: 'other',
      savedAt: 'second',
    })
    expect(next.draft).toBe(state.draft)
    expect(next.revision).toBe('original')
    expect(next.savedAt).toBe('first')
  })
  it('refreshes the applied version without changing the editor baseline', () => {
    const next = mergePolledState(state, {
      ...state,
      applied: 'mode: direct\n',
      appliedRevision: 'applied',
    })
    expect(next.appliedRevision).toBe('applied')
    expect(next.applied).toBe('mode: direct\n')
    expect(next.draft).toBe('mode: rule\n')
  })
  it('does not undo a successful save with an older in-flight response', () => {
    const saved = { ...state, draft: 'mode: direct\n', revision: 'saved' }
    expect(mergePolledState(saved, state).revision).toBe('saved')
    expect(mergePolledState(saved, state).draft).toBe(saved.draft)
  })
})
