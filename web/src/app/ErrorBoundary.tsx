import { Component, type ReactNode } from 'react'

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (this.state.failed)
      return (
        <main className="app-loading" role="alert">
          <h1>页面遇到错误</h1>
          <p>已保存的配置不受影响。重新载入会丢失本页尚未保存的修改。</p>
          <button className="button" onClick={() => location.reload()}>
            重新载入
          </button>
        </main>
      )
    return this.props.children
  }
}
