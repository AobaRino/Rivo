import { analyze } from './document'
self.onmessage = (event: MessageEvent<{ revision: number; text: string }>) => {
  const { revision, text } = event.data
  self.postMessage({ revision, result: analyze(text) })
}
