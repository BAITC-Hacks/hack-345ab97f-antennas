import type { CallEvent, Dialog, Scenario, VoiceRouterApi } from '../types'

const apiUrl = (import.meta.env.VITE_API_URL || 'http://localhost:8000').replace(/\/$/, '')
const wsUrl = import.meta.env.VITE_WS_URL || apiUrl.replace(/^http/, 'ws') + '/ws'
const sockets = new Map<string, WebSocket>()

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(apiUrl + path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
  } catch {
    throw new Error('Backend недоступен. Проверьте адрес сервера и соединение.')
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: unknown } | null
    const detail = typeof body?.detail === 'string' ? body.detail : `HTTP ${response.status}`
    throw new Error(detail)
  }
  return response.json() as Promise<T>
}

function getSocket(callId: string): WebSocket {
  const socket = sockets.get(callId)
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw new Error('WebSocket отключён. Начните новый звонок.')
  }
  return socket
}

function isCallEvent(value: unknown): value is CallEvent {
  if (!value || typeof value !== 'object') return false
  return ['status', 'transcript', 'route', 'reply', 'tts_audio', 'error', 'disconnected']
    .includes((value as { type?: string }).type ?? '')
}

function parseMessage(event: MessageEvent): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(event.data as string)
    return value && typeof value === 'object' ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

export const realApi: VoiceRouterApi = {
  listScenarios: () => request<Scenario[]>('/scenarios'),
  saveScenario: (scenario) => request<Scenario>(`/scenarios/${encodeURIComponent(scenario.id)}`, {
    method: 'PUT', body: JSON.stringify(scenario),
  }),
  listDialogs: () => request<Dialog[]>('/dialogs'),
  getDialog: (id) => request<Dialog>(`/dialogs/${encodeURIComponent(id)}`),

  async startCall() {
    const { callId } = await request<{ callId: string }>('/calls', { method: 'POST', body: '{}' })
    if (!callId) throw new Error('Backend не вернул callId.')
    const url = new URL(wsUrl)
    url.searchParams.set('callId', callId)
    const socket = new WebSocket(url)
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error('WebSocket не подключился за 5 секунд.')), 5000)
        socket.onopen = () => { window.clearTimeout(timeout); resolve() }
        socket.onerror = () => { window.clearTimeout(timeout); reject(new Error('WebSocket не подключился.')) }
        socket.onclose = () => { window.clearTimeout(timeout); reject(new Error('WebSocket закрыт.')) }
      })
    } catch (error) {
      socket.close()
      await request(`/calls/${encodeURIComponent(callId)}/end`, { method: 'POST', body: '{}' }).catch(() => undefined)
      throw error
    }
    sockets.set(callId, socket)
    return callId
  },

  async submitText(callId, text, onEvent, signal) {
    const socket = getSocket(callId)
    const message = (event: MessageEvent) => {
      const data = parseMessage(event)
      if (isCallEvent(data)) onEvent(data)
    }
    const closed = () => onEvent({ type: 'disconnected', message: 'WebSocket разорван. Начните новый звонок.' })
    socket.addEventListener('message', message)
    socket.addEventListener('close', closed)
    onEvent({ type: 'status', status: 'thinking' })
    try {
      return await request<Dialog>(`/calls/${encodeURIComponent(callId)}/turns`, {
        method: 'POST', body: JSON.stringify({ text }), signal,
      })
    } finally {
      socket.removeEventListener('message', message)
      socket.removeEventListener('close', closed)
    }
  },

  async submitAudio(callId, pcm16, onEvent, signal) {
    const socket = getSocket(callId)
    if (!pcm16.byteLength || pcm16.byteLength > 30 * 16000 * 2) {
      throw new Error('Запишите реплику длительностью до 30 секунд.')
    }
    return new Promise<Dialog>((resolve, reject) => {
      const timeout = window.setTimeout(() => finish(new Error('Ответ на аудио не пришёл за 60 секунд.')), 60000)
      const finish = (error?: Error, dialog?: Dialog) => {
        window.clearTimeout(timeout)
        socket.removeEventListener('message', message)
        socket.removeEventListener('close', closed)
        signal?.removeEventListener('abort', aborted)
        if (error) reject(error)
        else if (dialog) resolve(dialog)
      }
      const aborted = () => finish(new DOMException('Запрос отменён.', 'AbortError'))
      const closed = () => {
        onEvent({ type: 'disconnected', message: 'WebSocket разорван. Начните новый звонок.' })
        finish(new Error('WebSocket разорван.'))
      }
      const message = (event: MessageEvent) => {
        const data = parseMessage(event)
        if (isCallEvent(data)) {
          onEvent(data)
          if (data.type === 'error' && !data.message.startsWith('TTS:')) finish(new Error(data.message))
        }
        if (data?.type === 'dialog' && data.dialog) finish(undefined, data.dialog as Dialog)
      }
      socket.addEventListener('message', message)
      socket.addEventListener('close', closed)
      signal?.addEventListener('abort', aborted, { once: true })
      if (signal?.aborted) { aborted(); return }
      try {
        for (let offset = 0; offset < pcm16.byteLength; offset += 32000) {
          const chunk = pcm16.subarray(offset, offset + 32000)
          const encoded = btoa(String.fromCharCode(...chunk))
          socket.send(JSON.stringify({ type: 'audio_chunk', pcm16: encoded, sample_rate: 16000 }))
        }
        socket.send(JSON.stringify({ type: 'speech_end' }))
      } catch (error) {
        finish(error instanceof Error ? error : new Error('Не удалось отправить аудио.'))
      }
    })
  },

  async endCall(callId) {
    sockets.get(callId)?.close()
    sockets.delete(callId)
    await request(`/calls/${encodeURIComponent(callId)}/end`, { method: 'POST', body: '{}' })
  },
}
