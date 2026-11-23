import { requestSignalStorage } from './request-signal-storage.js'

/** Returns the signal of the current request handled by httpListener. */
export function getHttpRequestSignal(): AbortSignal | undefined {
  return requestSignalStorage.getStore()
}
