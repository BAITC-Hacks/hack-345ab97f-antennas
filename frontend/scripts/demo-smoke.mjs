import assert from 'node:assert/strict'
import { createServer } from 'vite'

const data = new Map()
globalThis.localStorage = {
  getItem: (key) => data.get(key) ?? null,
  setItem: (key, value) => data.set(key, value),
}
globalThis.window = { setTimeout, clearTimeout }

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
try {
  const { mockApi } = await vite.ssrLoadModule('/src/api/mockApi.ts')
  const catalog = await mockApi.listScenarios()
  assert.equal(catalog.length, 3)

  const events = []
  const callId = await mockApi.startCall()
  const dialog = await mockApi.submitText(
    callId,
    'Я оплатил, деньги списались, но заказ не подтвердился. Адрес доставки поменять.',
    (event) => events.push(event),
  )
  assert.equal(dialog.route.scenarioId, 'payment_not_confirmed')
  assert.equal(dialog.route.additionalIntents[0]?.scenarioId, 'change_delivery_address')
  assert.deepEqual(events.filter((event) => event.type === 'status').map((event) => event.status),
    ['listening', 'recognizing', 'thinking', 'speaking', 'completed'])
  assert.equal((await mockApi.getDialog(dialog.id))?.id, dialog.id)

  await mockApi.saveScenario({
    id: 'smoke_test',
    name: 'Smoke test',
    description: 'Persistence check',
    boundaries: [],
    examplesRu: [],
    examplesKk: [],
  })
  assert.ok((await mockApi.listScenarios()).some((item) => item.id === 'smoke_test'))
  assert.ok(data.has('tynda.voice-router.scenarios.v1'))
  console.log('Demo flow, trace, and catalog persistence: OK')
} finally {
  await vite.close()
}
