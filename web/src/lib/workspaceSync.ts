import type { State, WorkspaceStatus } from './api'

// A background core job must keep polling until it finishes. Only an in-flight
// editor request pauses synchronization, so an older response cannot undo it.
export function canPollWorkspace(state: State | null, requestBusy: boolean) {
  return !!state && !requestBusy
}

export function workspaceStatusKey(status: WorkspaceStatus) {
  // Statistics change every sample and do not require downloading YAML/history.
  return JSON.stringify([
    status.core,
    status.appliedRevision,
    status.runtime,
    status.networkEnabled,
    status.profilesRevision,
    status.autoStart,
    status.events,
  ])
}

export function shouldRefreshWorkspace(current: State, status: WorkspaceStatus) {
  return workspaceStatusKey(current) !== workspaceStatusKey(status)
}

// Polling cannot advance the editor's If-Match to somebody else's saved draft.
export function mergePolledState(current: State, incoming: State): State {
  return { ...incoming, draft: current.draft, revision: current.revision, savedAt: current.savedAt }
}
