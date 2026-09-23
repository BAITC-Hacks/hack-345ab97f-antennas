import type { CallEvent, Dialog, Scenario, VoiceRouterApi } from '../types'

const apiUrl = (import.meta.env.VITE_API_URL || 'http://localhost:8000').replace(/\/$/, '')
const wsUrl = import.meta.env.VITE_WS_URL || 'ws://localhost:8000/ws'
const sockets = new Map<string, WebSocket>()

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(apiUrl + path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
  } catch {
    throw new Error('Backend недоступен. Проверьте VITE_API_URL и запустите сервер.')
  }
  if (!response.ok) {
    throw new Error(`Backend вернул ${response.status}. Проверьте контракт ${path}.`)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

function isCallEvent(value: unknown): value is CallEvent {
  if (!value || typeof value !== 'object') return false
  return ['status', 'transcript', 'route', 'reply', 'disconnected'].includes((value as { type?: string }).type ?? '')
}

/**
 * Provisional adapter. No backend contract was present in the workspace.
 * TODO(team): align endpoint paths, request/response schemas, WebSocket event names,
 * auth if required, and audio encoding/upload with the actual backend.
 */
export const realApi: VoiceRouterApi = {
  listScenarios: () => request<Scenario[]>('/scenarios'),
  saveScenario: (scenario) => request<Scenario>(`/scenarios/${encodeURIComponent(scenario.id)}`, {
    method: 'PUT',
    body: JSON.stringify(scenario),
  }),
  listDialogs: () => request<Dialog[]>('/dialogs'),
  getDialog: (id) => request<Dialog>(`/dialogs/${encodeURIComponent(id)}`),
  async startCall() {
    const data = await request<{ callId: string }>('/calls', { method: 'POST', body: '{}' })
    if (!data?.callId) throw new Error('Backend не вернул callId.')
    // WebSocket is used for partial transcripts and status updates.
    const url = new URL(wsUrl)
    url.searchParams.set('callId', data.callId)
    const socket = new WebSocket(url)
    sockets.set(data.callId, socket)
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('WebSocket не подключился за 5 секунд.')), 5000)
      socket.onopen = () => { window.clearTimeout(timeout); resolve() }
      socket.onerror = () => { window.clearTimeout(timeout); reject(new Error('Не удалось подключить WebSocket.')) }
      socket.onclose = () => { window.clearTimeout(timeout); reject(new Error('WebSocket разорван. Повторите подключение.')) }
    }).catch((error: unknown) => {
      socket.close()
      sockets.delete(data.callId)
      throw error
    })
    return data.callId
  },
  async submitText(callId, text, onEvent, signal) {
    const socket = sockets.get(callId)
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      onEvent({ type: 'disconnected', message: 'WebSocket разорван. Повторите подключение.' })
      throw new Error('WebSocket разорван. Повторите подключение.')
    }
    onEvent({ type: 'status', status: 'recognizing' })
    const result = new Promise<Dialog>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Нет ответа от Backend в течение 15 секунд.')), 15000)
      const cleanup = () => {
        window.clearTimeout(timeout)
        socket.removeEventListener('message', message)
        socket.removeEventListener('close', closed)
        signal?.removeEventListener('abort', aborted)
      }
      const aborted = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')) }
      const closed = () => {
        cleanup()
        onEvent({ type: 'disconnected', message: 'WebSocket разорван. Повторите подключение.' })
        reject(new Error('WebSocket разорван. Повторите подключение.'))
      }
      const message = (event: MessageEvent) => {
        try {
          const data: unknown = JSON.parse(event.data as string)
          if (isCallEvent(data)) onEvent(data)
          if (data && typeof data === 'object' && 'type' in data && data.type === 'dialog' && 'dialog' in data) {
            cleanup()
            resolve(data.dialog as Dialog)
          }
        } catch {
          // Ignore non-JSON messages until the agreed event contract is available.
        }
      }
      socket.addEventListener('message', message)
      socket.addEventListener('close', closed)
      signal?.addEventListener('abort', aborted, { once: true })
    })
    try {
      // TODO(team): confirm whether text is sent over REST or the WebSocket.
      const [, dialog] = await Promise.all([
        request<unknown>(`/calls/${encodeURIComponent(callId)}/turns`, {
          method: 'POST',
          body: JSON.stringify({ text }),
          signal,
        }),
        result,
      ])
      return dialog
    } catch (error) {
      // The result promise has a timeout; close the socket to reject it immediately.
      socket.close()
      throw error
    }
  },
  async endCall(callId) {
    sockets.get(callId)?.close()
    sockets.delete(callId)
    await request<unknown>(`/calls/${encodeURIComponent(callId)}/end`, { method: 'POST', body: '{}' })
  },
}
