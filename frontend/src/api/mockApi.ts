import type { CallEvent, Dialog, Language, RouteDecision, Scenario, Transcript, VoiceRouterApi } from '../types'

const catalogKey = 'tynda.voice-router.scenarios.v1'
const dialogsKey = 'tynda.voice-router.dialogs.v1'

export const seedScenarios: Scenario[] = [
  {
    id: 'payment_not_confirmed',
    name: 'Оплата не подтверждена',
    description: 'Деньги списались, но заказ не перешёл в оплаченный статус.',
    boundaries: ['Не оформлять возврат до проверки статуса платежа', 'Если платёж не найден, передать оператору'],
    examplesRu: ['Я оплатил заказ, деньги списались, но подтверждения нет'],
    examplesKk: ['Төлем жасадым, бірақ тапсырыс расталмады'],
  },
  {
    id: 'change_delivery_address',
    name: 'Изменить адрес доставки',
    description: 'Клиент хочет обновить адрес до отправки заказа.',
    boundaries: ['После передачи курьеру требуется оператор', 'Сначала подтвердить номер заказа'],
    examplesRu: ['Хочу поменять адрес доставки'],
    examplesKk: ['Жеткізу мекенжайын өзгерткім келеді'],
  },
  {
    id: 'refund_request',
    name: 'Запрос возврата',
    description: 'Клиент хочет вернуть оплату или уточнить статус возврата.',
    boundaries: ['Не обещать срок возврата без проверки', 'Не создавать повторный возврат'],
    examplesRu: ['Верните деньги за заказ'],
    examplesKk: ['Тапсырыс үшін ақшаны қайтарыңыз'],
  },
]

const sampleText = 'Я вчера оплатил, деньги списались, но заказ не подтвердился. И ещё адрес доставки поменять.'
const sampleRoute: RouteDecision = {
  turnId: 'turn-demo-01',
  scenarioId: 'payment_not_confirmed',
  decision: 'route',
  confidence: 0.86,
  path: 'llm',
  reason: 'Деньги списаны, но заказ не подтверждён.',
  topicSwitch: false,
  additionalIntents: [{ scenarioId: 'change_delivery_address', confidence: 0.74 }],
  alternatives: [{ scenarioId: 'refund_request', confidence: 0.28, whyNot: 'Клиент пока не просит вернуть деньги.' }],
}

const seedDialogs: Dialog[] = [
  {
    id: 'demo-1042',
    createdAt: '2026-09-23T09:42:00+05:00',
    status: 'completed',
    transcript: { turnId: 'turn-demo-01', text: sampleText, lang: 'ru', isFinal: true },
    route: sampleRoute,
    timings: { endpoint: 300, stt: 180, route: 420, exec: 25, firstAudio: 190, playback: 80, total: 1195 },
    reply: 'Вижу, что оплата прошла, а заказ ещё не подтверждён. Проверю статус платежа. Затем помогу изменить адрес доставки.',
  },
  {
    id: 'demo-1041',
    createdAt: '2026-09-23T09:35:00+05:00',
    status: 'completed',
    transcript: { turnId: 'turn-demo-02', text: 'Төлем жасадым, бірақ тапсырыс расталмады.', lang: 'kk', isFinal: true },
    route: { ...sampleRoute, turnId: 'turn-demo-02', confidence: 0.82, reason: 'Төлем жасалған, тапсырыс расталмаған.', additionalIntents: [] },
    timings: { endpoint: 320, stt: 210, route: 440, exec: 27, firstAudio: 205, playback: 96, total: 1298 },
    reply: 'Төлем күйін тексеруге көмектесемін. Тапсырыс нөмірін айтыңыз.',
  },
  {
    id: 'demo-1040',
    createdAt: '2026-09-23T09:28:00+05:00',
    status: 'handoff',
    transcript: { turnId: 'turn-demo-03', text: 'Заказ уже у курьера, но мне срочно нужно поменять адрес.', lang: 'ru', isFinal: true },
    route: { ...sampleRoute, turnId: 'turn-demo-03', scenarioId: 'change_delivery_address', decision: 'handoff', confidence: 0.91, reason: 'Заказ уже у курьера: изменение адреса требует оператора.', additionalIntents: [], alternatives: [] },
    timings: { endpoint: 280, stt: 200, route: 390, exec: 22, firstAudio: 185, playback: 95, total: 1172 },
    reply: 'Соединяю с оператором, чтобы согласовать новый адрес с курьером.',
    handoffReason: 'Заказ передан курьеру; изменение адреса требует ручного согласования.',
  },
]

function readStorage<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key)
    return value ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}

function writeStorage<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    throw new Error('Не удалось сохранить изменения в браузере. Проверьте доступность localStorage.')
  }
}

function detectLanguage(text: string): Language {
  const hasKazakh = /[әғқңөұүһі]/i.test(text)
  const hasRussian = /[ыэёъ]/i.test(text)
  return hasKazakh ? (hasRussian ? 'mixed' : 'kk') : 'ru'
}

function chooseRoute(text: string, turnId: string, scenarios: Scenario[]): RouteDecision {
  const lower = text.toLowerCase()
  const payment = /оплат|деньг|списа|төлем|ақша|растал|подтверд/.test(lower)
  const address = /адрес|достав|мекенжай|жеткіз/.test(lower)
  const refund = /возврат|вернут|қайтар/.test(lower)
  const courier = /курьер|курьерге/.test(lower)
  const known = new Set(scenarios.map((item) => item.id))
  const scenarioId = payment && known.has('payment_not_confirmed') ? 'payment_not_confirmed'
    : address && known.has('change_delivery_address') ? 'change_delivery_address'
      : refund && known.has('refund_request') ? 'refund_request' : null
  const handoff = courier && address
  return {
    turnId,
    scenarioId,
    decision: handoff ? 'handoff' : scenarioId ? 'route' : 'clarify',
    confidence: handoff ? 0.91 : payment ? 0.86 : scenarioId ? 0.82 : null,
    path: 'llm',
    reason: handoff ? 'Заказ уже у курьера: требуется оператор.' : payment ? 'Деньги списаны, но заказ не подтверждён.'
      : address ? 'Клиент просит изменить адрес доставки.' : refund ? 'Клиент запрашивает возврат.'
        : 'Нужно уточнить, с каким заказом и вопросом обратился клиент.',
    topicSwitch: false,
    additionalIntents: payment && address && known.has('change_delivery_address')
      ? [{ scenarioId: 'change_delivery_address', confidence: 0.74 }] : [],
    alternatives: payment && known.has('refund_request')
      ? [{ scenarioId: 'refund_request', confidence: 0.28, whyNot: 'Клиент пока не просит вернуть деньги.' }] : [],
  }
}

function makeReply(route: RouteDecision, lang: Language): string {
  if (route.decision === 'handoff') return 'Соединяю с оператором, чтобы согласовать новый адрес с курьером.'
  if (route.decision === 'clarify') return lang === 'kk' ? 'Қай тапсырыс туралы айтып тұрғаныңызды нақтылаңыз.' : 'Уточните, пожалуйста, номер заказа и что именно произошло.'
  if (route.scenarioId === 'payment_not_confirmed') return lang === 'kk'
    ? 'Төлем күйін тексеруге көмектесемін. Тапсырыс нөмірін айтыңыз.'
    : route.additionalIntents.length
      ? 'Вижу, что оплата прошла, а заказ ещё не подтверждён. Проверю статус платежа. Затем помогу изменить адрес доставки.'
      : 'Проверю статус платежа и заказа. Подскажите номер заказа.'
  if (route.scenarioId === 'change_delivery_address') return 'Помогу изменить адрес. Подскажите номер заказа и новый адрес доставки.'
  return 'Проверю условия возврата по вашему заказу. Подскажите его номер.'
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const timer = window.setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    const abort = () => { window.clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export const mockApi: VoiceRouterApi = {
  async listScenarios() { return readStorage<Scenario[]>(catalogKey, seedScenarios) },
  async saveScenario(scenario) {
    const scenarios = await this.listScenarios()
    const index = scenarios.findIndex((item) => item.id === scenario.id)
    const next = [...scenarios]
    if (index >= 0) next[index] = scenario
    else next.unshift(scenario)
    writeStorage(catalogKey, next)
    return scenario
  },
  async listDialogs() { return [...readStorage<Dialog[]>(dialogsKey, []), ...seedDialogs] },
  async getDialog(id) { return (await this.listDialogs()).find((dialog) => dialog.id === id) ?? null },
  async startCall() { return 'demo-call-' + Date.now() },
  async submitText(_callId, text, onEvent, signal) {
    const turnId = 'turn-' + Date.now()
    const lang = detectLanguage(text)
    const transcript: Transcript = { turnId, text, lang, isFinal: true }
    const route = chooseRoute(text, turnId, await this.listScenarios())
    const reply = makeReply(route, lang)
    const emit = (event: CallEvent) => onEvent(event)
    emit({ type: 'status', status: 'listening' })
    await pause(280, signal)
    emit({ type: 'status', status: 'recognizing' })
    emit({ type: 'transcript', transcript: { ...transcript, isFinal: false } })
    await pause(310, signal)
    emit({ type: 'transcript', transcript })
    emit({ type: 'status', status: 'thinking' })
    await pause(460, signal)
    emit({ type: 'route', route })
    emit({ type: 'status', status: 'speaking' })
    emit({ type: 'reply', text: reply })
    await pause(360, signal)
    emit({ type: 'status', status: 'completed' })
    const dialog: Dialog = {
      id: 'demo-' + Date.now(),
      createdAt: new Date().toISOString(),
      status: route.decision === 'handoff' ? 'handoff' : 'completed',
      transcript,
      route,
      timings: { endpoint: 300, stt: 180, route: 420, exec: 25, firstAudio: 190, playback: 80, total: 1195 },
      reply,
      ...(route.decision === 'handoff' ? { handoffReason: route.reason } : {}),
    }
    writeStorage(dialogsKey, [dialog, ...readStorage<Dialog[]>(dialogsKey, [])].slice(0, 30))
    return dialog
  },
  async endCall() {},
}
