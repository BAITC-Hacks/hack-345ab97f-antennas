import assert from 'node:assert/strict'
import { createServer } from 'vite'

globalThis.window = { setTimeout, clearTimeout }
const sent = []
let activeSocket

class FakeWebSocket {
  static OPEN = 1
  readyState = 0
  listeners = new Map()

  constructor(url) {
    assert.equal(new URL(url).searchParams.get('callId'), 'call-1')
    activeSocket = this
    queueMicrotask(() => { this.readyState = FakeWebSocket.OPEN; this.onopen?.() })
  }

  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((value) => value !== listener))
  }

  emit(event) {
    for (const listener of this.listeners.get('message') ?? []) listener({ data: JSON.stringify(event) })
  }

  send(value) {
    const event = JSON.parse(value)
    sent.push(event)
    if (event.type === 'speech_end') {
      queueMicrotask(() => {
        this.emit({ type: 'transcript', transcript: dialog.transcript })
        this.emit({ type: 'dialog', dialog })
      })
    }
  }

  close() { this.readyState = 3 }
}
globalThis.WebSocket = FakeWebSocket

const dialog = {
  id: 'turn-1', createdAt: '2026-09-23T12:00:00Z', status: 'completed',
  transcript: { turnId: 'turn-1', text: 'Страховка', lang: 'ru', isFinal: true },
  route: { turnId: 'turn-1', scenarioId: 'buy_policy', decision: 'route', confidence: 0.8,
    path: 'llm', reason: 'Запрос на полис', additionalIntents: [], alternatives: [] },
  timings: { route: 5, total: 6 }, reply: 'Помогу оформить полис.',
}
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
})
globalThis.fetch = async (url, init) => {
  const path = new URL(url).pathname
  if (path === '/calls' && init.method === 'POST') return json({ callId: 'call-1' }, 201)
  if (path === '/calls/call-1/turns' && init.method === 'POST') {
    assert.deepEqual(JSON.parse(init.body), { text: 'Страховка' })
    queueMicrotask(() => {
      activeSocket.emit({ type: 'status', status: 'thinking' })
      activeSocket.emit({ type: 'route', route: dialog.route })
      activeSocket.emit({ type: 'reply', text: dialog.reply })
    })
    return json(dialog)
  }
  if (path === '/calls/call-1/end') return json({ status: 'ended' })
  throw new Error(`Unexpected fetch: ${path}`)
}

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
try {
  const { realApi } = await vite.ssrLoadModule('/src/api/realApi.ts')
  const callId = await realApi.startCall()
  const progress = []
  const textResult = await realApi.submitText(callId, 'Страховка', (event) => progress.push(event.type))
  assert.equal(textResult.id, dialog.id)
  assert.ok(progress.includes('route'))
  const audioResult = await realApi.submitAudio(callId, new Uint8Array([0, 0, 1, 0]),
    (event) => progress.push(event.type))
  assert.equal(audioResult.id, dialog.id)
  assert.deepEqual(sent.map((event) => event.type), ['audio_chunk', 'speech_end'])
  assert.equal(sent[0].sample_rate, 16000)
  assert.equal(sent[0].pcm16, 'AAABAA==')
  assert.ok(progress.includes('transcript'))
  await realApi.endCall(callId)
  console.log('Live REST/WebSocket adapter: OK')
} finally {
  await vite.close()
}
