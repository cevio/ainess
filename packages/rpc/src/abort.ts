import { addAbortListener } from 'node:events'

const removeEventListener = EventTarget.prototype.removeEventListener

export function observeAbort(signal: AbortSignal, listener: () => void): () => void {
  let observer: typeof listener | undefined = listener
  const notify = () => observer?.()
  let remove: (() => void) | undefined = () => {
    try {
      removeEventListener.call(signal, 'abort', notify)
    } catch {
      // A customized signal may not use the native EventTarget listener list.
    }
  }
  let subscription: Disposable | undefined
  try {
    subscription = addAbortListener(signal, notify)
  } catch (error) {
    observer = undefined
    remove()
    throw error
  }
  return () => {
    observer = undefined
    const active = subscription
    const detach = remove
    subscription = undefined
    remove = undefined
    try {
      active?.[Symbol.dispose]()
    } catch {
      // An application's removal hook must not interrupt RPC cleanup.
    } finally {
      // A successful custom hook may still leave the native listener attached.
      detach?.()
    }
  }
}
