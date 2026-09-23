import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { api, isDemo } from './api'
import type { CallEvent, CallStatus, Decision, Dialog, Language, Scenario, TraceTimings } from './types'

type Page = '/call' | '/trace' | '/supervisor' | '/catalog'
const pages: Array<{ path: Page; label: string; icon: string }> = [
  { path: '/call', label: 'Звонок', icon: '◉' },
  { path: '/trace', label: 'Трассировка', icon: '▥' },
  { path: '/supervisor', label: 'Супервизор', icon: '▦' },
  { path: '/catalog', label: 'Каталог', icon: '▤' },
]
const sampleRu = 'Я вчера оплатил, деньги списались, но заказ не подтвердился. И ещё адрес доставки поменять.'
const sampleKk = 'Төлем жасадым, бірақ тапсырыс расталмады.'
const sampleMixed = 'Заказды оплатил, бірақ адрес доставки өзгерткім келеді.'
const stageMeta: Array<{ key: keyof TraceTimings; label: string; budget: number }> = [
  { key: 'endpoint', label: 'Endpointing', budget: 300 },
  { key: 'stt', label: 'STT', budget: 200 },
  { key: 'route', label: 'Router', budget: 450 },
  { key: 'exec', label: 'Executor', budget: 30 },
  { key: 'firstAudio', label: 'First audio', budget: 200 },
  { key: 'playback', label: 'Playback / network', budget: 100 },
]
const statusLabels: Record<CallStatus, string> = {
  ready: 'Готов к звонку',
  connecting: 'Подключение',
  listening: 'Слушаем',
  recognizing: 'Распознаём',
  thinking: 'Маршрутизируем',
  speaking: 'Отвечаем',
  completed: 'Ответ готов',
  error: 'Ошибка',
  disconnected: 'Связь потеряна',
}
const decisionLabels: Record<Decision, string> = {
  route: 'Маршрут выбран',
  continue: 'Продолжение',
  clarify: 'Уточнение',
  handoff: 'Передача оператору',
  out_of_scope: 'Вне сценариев',
}
const languageLabels: Record<Language, string> = { ru: 'RU', kk: 'KK', mixed: 'MIXED' }
const ms = (value?: number) => typeof value === 'number' ? `${value} мс` : 'нет данных'
const pct = (value: number | null) => typeof value === 'number' ? `${Math.round(value * 100)}%` : '—'
const dateTime = (value: string) => new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
const scenarioName = (id: string | null, scenarios: Scenario[]) => id ? scenarios.find((item) => item.id === id)?.name ?? id : 'Не выбран'
const isPage = (value: string): value is Page => pages.some((item) => item.path === value)

function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'green' | 'amber' | 'red' | 'blue' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>
}

function Empty({ title, detail }: { title: string; detail: string }) {
  return <div className="empty"><div className="empty-icon">◇</div><strong>{title}</strong><p>{detail}</p></div>
}

function CallPage({ scenarios, dialogs, onDialog, onTrace }: {
  scenarios: Scenario[]
  dialogs: Dialog[]
  onDialog: (dialog: Dialog) => void
  onTrace: (id: string) => void
}) {
  const [status, setStatus] = useState<CallStatus>('ready')
  const [callId, setCallId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [transcript, setTranscript] = useState<Dialog['transcript'] | null>(null)
  const [route, setRoute] = useState<Dialog['route'] | null>(null)
  const [reply, setReply] = useState('')
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [showPreview, setShowPreview] = useState(true)
  const [error, setError] = useState('')
  const [micMessage, setMicMessage] = useState('Микрофон ещё не включён')
  const [micActive, setMicActive] = useState(false)
  const [ttsMessage, setTtsMessage] = useState('')
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const workingRef = useRef(false)
  const preview = dialog ?? (showPreview ? dialogs[0] : undefined)
  const displayTranscript = transcript ?? preview?.transcript
  const displayRoute = route ?? preview?.route
  const displayReply = reply || preview?.reply

  useEffect(() => () => {
    abortRef.current?.abort()
    recorderRef.current?.stop()
    streamRef.current?.getTracks().forEach((track) => track.stop())
  }, [])

  function releaseMicrophone() {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
    recorderRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    setMicActive(false)
    setMicMessage('Микрофон выключен')
  }

  async function connect(withMicrophone: boolean): Promise<string | null> {
    setStatus('connecting')
    setError('')
    if (withMicrophone) {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Микрофон недоступен в этом браузере.')
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        streamRef.current = stream
        setMicActive(true)
        setMicMessage('Микрофон разрешён')
        if (typeof MediaRecorder !== 'undefined') {
          recorderRef.current = new MediaRecorder(stream)
          recorderRef.current.start()
          setMicMessage('Идёт локальная запись')
        }
      } catch {
        setMicMessage('Доступ запрещён — используйте текстовый ввод')
      }
    }
    try {
      const id = await api.startCall()
      setCallId(id)
      setStatus('listening')
      return id
    } catch (cause) {
      releaseMicrophone()
      setStatus('error')
      setError(cause instanceof Error ? cause.message : 'Не удалось начать звонок.')
      return null
    }
  }

  function handleEvent(event: CallEvent) {
    if (event.type === 'status') setStatus(event.status)
    if (event.type === 'transcript') setTranscript(event.transcript)
    if (event.type === 'route') setRoute(event.route)
    if (event.type === 'reply') {
      setReply(event.text)
      if (event.ttsUrl) {
        void new Audio(event.ttsUrl).play().catch(() => setTtsMessage('Аудио недоступно, текст ответа сохранён.'))
      } else setTtsMessage('Текстовый ответ · TTS недоступен')
    }
    if (event.type === 'disconnected') {
      setStatus('disconnected')
      setError(event.message)
    }
  }

  async function sendText(value = input) {
    const text = value.trim()
    if (!text || workingRef.current) return
    workingRef.current = true
    setInput('')
    setError('')
    setTtsMessage('')
    setTranscript(null)
    setRoute(null)
    setReply('')
    setDialog(null)
    setShowPreview(false)
    const id = callId ?? await connect(false)
    if (!id) { workingRef.current = false; return }
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const result = await api.submitText(id, text, handleEvent, controller.signal)
      setDialog(result)
      onDialog(result)
    } catch (cause) {
      if (!controller.signal.aborted) {
        setStatus('error')
        setError(cause instanceof Error ? cause.message : 'Не удалось обработать реплику.')
        setInput(text)
      }
    } finally {
      workingRef.current = false
      abortRef.current = null
    }
  }

  async function endCall() {
    abortRef.current?.abort()
    releaseMicrophone()
    if (callId) {
      try { await api.endCall(callId) }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось завершить звонок.') }
    }
    setCallId(null)
    setStatus('ready')
  }

  async function newDialog() {
    await endCall()
    setTranscript(null)
    setRoute(null)
    setReply('')
    setDialog(null)
    setShowPreview(false)
    setInput('')
    setError('')
    setTtsMessage('')
  }

  const busy = ['connecting', 'recognizing', 'thinking', 'speaking'].includes(status)
  return <div className="page">
    <div className="page-heading">
      <div><span className="eyebrow">VOICE WORKSPACE / 01</span><h1>Звонок с клиентом</h1><p>Одна реплика — прозрачное решение маршрутизатора и следующий шаг.</p></div>
      <Badge tone={isDemo ? 'blue' : 'green'}>{isDemo ? 'Demo data' : 'Live backend'}</Badge>
    </div>
    <div className="call-grid">
      <section className="panel call-panel">
        <div className="panel-top"><span className="section-label">Активный канал</span><span className={`live-dot ${micActive ? 'is-on' : ''}`}>{micActive ? 'MIC ON' : 'MIC OFF'}</span></div>
        <div className="call-center">
          <div className={`voice-orb ${micActive ? 'is-active' : ''}`}><span>◉</span></div>
          <div className="status-line"><span className={`status-indicator status-${status}`} />{statusLabels[status]}</div>
          <p className="muted center">{callId ? 'Канал открыт · можно отправить следующую реплику' : 'Начните звонок или отправьте текстовую реплику'}</p>
          <div className="call-actions">
            {!callId ? <button className="primary-button large" onClick={() => void connect(true)}>◉ &nbsp; Начать звонок</button>
              : <button className="danger-button large" onClick={() => void endCall()}>■ &nbsp; Завершить звонок</button>}
            <button className="ghost-button" onClick={() => void newDialog()}>↻ &nbsp; Новый диалог</button>
          </div>
          <div className="mic-note"><span className={micActive ? 'mic-pulse' : 'mic-outline'}>●</span>{micMessage}</div>
          {micActive && <button className="text-button" onClick={() => { releaseMicrophone(); setMicMessage('Запись остановлена · отправьте реплику текстом') }}>Остановить запись</button>}
        </div>
        <div className="step-track">
          {(['listening', 'recognizing', 'thinking', 'speaking', 'completed'] as CallStatus[]).map((step, index) =>
            <div className={`step ${status === step ? 'current' : ''}`} key={step}><span>{String(index + 1).padStart(2, '0')}</span>{statusLabels[step]}</div>)}
        </div>
        <div className="input-area">
          <div className="input-header"><span className="section-label">Текстовый fallback</span><span className="muted small">Работает без микрофона</span></div>
          <form onSubmit={(event) => { event.preventDefault(); void sendText() }} className="message-form">
            <textarea aria-label="Реплика клиента" placeholder="Например: деньги списались, но заказ не подтвердился…" value={input} onChange={(event) => setInput(event.target.value)} rows={3} />
            <button className="primary-button" disabled={!input.trim() || busy} type="submit">Отправить ↗</button>
          </form>
          <div className="samples"><span>Примеры:</span><button onClick={() => void sendText(sampleRu)} disabled={busy}>Два намерения · RU</button><button onClick={() => void sendText(sampleKk)} disabled={busy}>Қазақша · KK</button><button onClick={() => void sendText(sampleMixed)} disabled={busy}>Mixed</button></div>
        </div>
      </section>

      <div className="call-side">
        <section className="panel detail-panel">
          <div className="panel-top"><span className="section-label">{dialog || transcript ? 'Текущая реплика' : 'Пример реплики'}</span>{displayTranscript && <Badge>{languageLabels[displayTranscript.lang]}</Badge>}</div>
          <div className="quote-mark">“</div>
          <p className="transcript-text">{displayTranscript?.text ?? 'После звонка здесь появится живой и финальный транскрипт.'}</p>
          <div className="transcript-footer"><span>{transcript?.isFinal === false ? '● Живой транскрипт' : displayTranscript ? '✓ Финальный транскрипт' : 'Ожидание'}</span><span>{displayTranscript?.turnId ?? '—'}</span></div>
        </section>
        <section className="panel route-panel">
          <div className="panel-top"><span className="section-label">Решение роутера</span>{displayRoute && <Badge tone="green">{decisionLabels[displayRoute.decision]}</Badge>}</div>
          <h2>{displayRoute ? scenarioName(displayRoute.scenarioId, scenarios) : 'Ожидаем решение'}</h2>
          <p className="mono-id">{displayRoute?.scenarioId ?? 'scenario_id: —'}</p>
          <div className="route-facts"><div><span>Уверенность</span><strong>{pct(displayRoute?.confidence ?? null)}</strong></div><div><span>Путь</span><strong>{displayRoute?.path === 'fast' ? 'Fast path' : displayRoute ? 'LLM' : '—'}</strong></div></div>
          {displayRoute?.additionalIntents?.length ? <div className="intent-queue"><span className="section-label">Следом в очереди</span>{displayRoute.additionalIntents.map((intent) => <p key={intent.scenarioId}>↳ {scenarioName(intent.scenarioId, scenarios)} <b>{pct(intent.confidence)}</b></p>)}</div> : null}
          {preview && <button className="outline-button full" onClick={() => onTrace(preview.id)}>Открыть трассировку <span>↗</span></button>}
        </section>
        <section className="panel reply-panel"><div className="panel-top"><span className="section-label">Ответ помощника</span><span className="reply-symbol">✳</span></div><p>{displayReply ?? 'Ответ появится после обработки реплики.'}</p><span className="muted small">{ttsMessage || (displayReply ? 'Текст ответа доступен' : 'Ожидание реплики')}</span></section>
      </div>
    </div>
    {error && <div role="alert" className="alert error-alert">{error} {status === 'disconnected' && <button onClick={() => { setCallId(null); void connect(false) }}>Подключиться снова</button>}</div>}
    {isDemo && <p className="demo-disclaimer">Демо-данные показывают сценарий интерфейса. Значения задержки на примере не являются измерением реальной системы.</p>}
  </div>
}

function Waterfall({ timings }: { timings: TraceTimings }) {
  const total = timings.total ?? stageMeta.reduce((sum, item) => sum + (timings[item.key] ?? 0), 0)
  if (!total) return <Empty title="Нет данных трассировки" detail="Задержки появятся после обработки реплики backend." />
  let offset = 0
  return <div className="waterfall">
    <div className="waterfall-axis"><span>0 мс</span><span>{Math.round(total / 4)} мс</span><span>{Math.round(total / 2)} мс</span><span>{Math.round(total * .75)} мс</span><span>{total} мс</span></div>
    {stageMeta.map(({ key, label, budget }) => {
      const value = timings[key]
      const start = offset
      if (typeof value === 'number') offset += value
      const level = typeof value !== 'number' ? 'missing' : value > budget * 1.25 ? 'over' : value > budget ? 'near' : 'normal'
      return <div className={`waterfall-row ${key === 'route' ? 'router-row' : ''}`} key={key}>
        <div className="waterfall-name"><span className="stage-icon">{key === 'route' ? '✳' : '◌'}</span>{label}</div>
        <div className="waterfall-track">{typeof value === 'number'
          ? <div className={`waterfall-bar ${level}`} style={{ left: `${start / total * 100}%`, width: `${Math.max(value / total * 100, 1.5)}%` }} title={`${label}: ${value} мс · ${start}–${offset} мс · ориентир ${budget} мс`} />
          : <span className="no-timing">нет данных</span>}</div>
        <strong>{ms(value)}</strong>
      </div>
    })}
    <div className="waterfall-legend"><span><i className="legend-green" />В бюджете</span><span><i className="legend-amber" />Погранично</span><span><i className="legend-red" />Выше бюджета</span></div>
  </div>
}

function TracePage({ dialogs, scenarios, selectedId, onSelect }: { dialogs: Dialog[]; scenarios: Scenario[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const dialog = dialogs.find((item) => item.id === selectedId) ?? dialogs[0]
  return <div className="page">
    <div className="page-heading"><div><span className="eyebrow">DECISION EXPLAINER / 02</span><h1>Трассировка решения</h1><p>От реплики клиента до первого аудио — каждый этап на общей шкале.</p></div><select aria-label="Выбрать диалог" value={dialog?.id ?? ''} onChange={(event) => onSelect(event.target.value)}>{dialogs.map((item) => <option key={item.id} value={item.id}>{item.id} · {dateTime(item.createdAt)}</option>)}</select></div>
    {!dialog ? <Empty title="Нет данных трассировки" detail="Отправьте реплику на экране звонка, затем откройте её трассировку." /> : <>
      <div className="summary-strip"><div><span>Общая задержка</span><strong>{ms(dialog.timings.total)}</strong></div><div><span>Сценарий</span><strong>{scenarioName(dialog.route.scenarioId, scenarios)}</strong></div><div><span>Решение</span><strong>{decisionLabels[dialog.route.decision]}</strong></div><div><span>Путь</span><strong>{dialog.route.path === 'fast' ? 'Fast path' : 'LLM'}</strong></div></div>
      <div className="trace-grid">
        <section className="panel trace-main"><div className="panel-top"><span className="section-label">Путь обработки</span><Badge tone="blue">Router выделен</Badge></div><h2>Waterfall по этапам</h2><p className="muted">Длительности расположены последовательно. Наведите курсор на полосу для границ этапа и ориентира.</p><Waterfall timings={dialog.timings} /></section>
        <section className="panel trace-aside"><span className="section-label">Входная реплика</span><p className="trace-quote">“{dialog.transcript.text}”</p><Badge>{languageLabels[dialog.transcript.lang]}</Badge><div className="divider" /><span className="section-label">Почему выбран сценарий</span><h3>{scenarioName(dialog.route.scenarioId, scenarios)}</h3><p>{dialog.route.reason || 'Причина не предоставлена.'}</p><div className="small-facts"><span>Confidence <b>{pct(dialog.route.confidence)}</b></span><span>Topic switch <b>{dialog.route.topicSwitch ? 'Да' : 'Нет'}</b></span></div></section>
      </div>
      <div className="trace-bottom">
        <section className="panel"><span className="section-label">Дополнительные намерения</span>{dialog.route.additionalIntents?.length ? dialog.route.additionalIntents.map((intent) => <div className="list-line" key={intent.scenarioId}><span>{scenarioName(intent.scenarioId, scenarios)}</span><b>{pct(intent.confidence)}</b></div>) : <p className="muted">Не обнаружены</p>}</section>
        <section className="panel"><span className="section-label">Альтернативы</span>{dialog.route.alternatives?.length ? dialog.route.alternatives.map((item) => <div className="alternative" key={item.scenarioId}><div className="list-line"><span>{scenarioName(item.scenarioId, scenarios)}</span><b>{pct(item.confidence)}</b></div><p>{item.whyNot || 'Причина не указана'}</p></div>) : <p className="muted">Нет альтернатив</p>}</section>
      </div>
      <details className="raw-json"><summary>Raw JSON <span>↗</span></summary><pre>{JSON.stringify(dialog, null, 2)}</pre></details>
    </>}
  </div>
}

function SupervisorPage({ dialogs, scenarios, onTrace }: { dialogs: Dialog[]; scenarios: Scenario[]; onTrace: (id: string) => void }) {
  const [language, setLanguage] = useState('')
  const [scenario, setScenario] = useState('')
  const [decision, setDecision] = useState('')
  const filtered = dialogs.filter((item) => (!language || item.transcript.lang === language) && (!scenario || item.route.scenarioId === scenario) && (!decision || item.route.decision === decision))
  const handoff = dialogs.find((item) => item.status === 'handoff')
  const latest = dialogs[0]
  const maxStage = Math.max(1, ...stageMeta.map((item) => latest?.timings[item.key] ?? 0))
  const metrics = ['Top-1 accuracy', 'Routing p50 / p95', 'Total p50 / p95', 'Clarify rate', 'Handoff rate']
  return <div className="page">
    <div className="page-heading"><div><span className="eyebrow">OPERATIONS / 03</span><h1>Супервизор</h1><p>Решения и задержки диалогов в одном рабочем обзоре.</p></div><Badge tone={isDemo ? 'blue' : 'green'}>{isDemo ? 'Demo data' : 'Live backend'}</Badge></div>
    <div className="metric-grid">{metrics.map((label) => <div className="panel metric-card" key={label}><span>{label}</span><strong>—</strong><small>Ожидает real eval</small></div>)}</div>
    <div className="supervisor-grid">
      <section className="panel dialogs-panel"><div className="panel-top"><div><span className="section-label">Последние диалоги</span><h2>Очередь решений</h2></div><span className="count-pill">{filtered.length} записей</span></div>
        <div className="filters"><select aria-label="Фильтр по языку" value={language} onChange={(event) => setLanguage(event.target.value)}><option value="">Все языки</option><option value="ru">RU</option><option value="kk">KK</option><option value="mixed">MIXED</option></select><select aria-label="Фильтр по сценарию" value={scenario} onChange={(event) => setScenario(event.target.value)}><option value="">Все сценарии</option>{scenarios.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select><select aria-label="Фильтр по решению" value={decision} onChange={(event) => setDecision(event.target.value)}><option value="">Все решения</option>{Object.entries(decisionLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>
        <div className="table-wrap"><table><thead><tr><th>Диалог</th><th>Язык</th><th>Сценарий</th><th>Решение</th><th>Total</th><th>Статус</th><th></th></tr></thead><tbody>{filtered.map((item) => <tr key={item.id}><td><strong>{item.id}</strong><small>{dateTime(item.createdAt)}</small></td><td>{languageLabels[item.transcript.lang]}</td><td>{scenarioName(item.route.scenarioId, scenarios)}</td><td>{decisionLabels[item.route.decision]}</td><td>{ms(item.timings.total)}</td><td><Badge tone={item.status === 'handoff' ? 'amber' : item.status === 'error' ? 'red' : 'green'}>{item.status}</Badge></td><td><button className="table-link" onClick={() => onTrace(item.id)}>Открыть ↗</button></td></tr>)}</tbody></table>{!filtered.length && <Empty title="Диалогов нет" detail="Измените фильтры или отправьте новую реплику." />}</div>
      </section>
      <div className="supervisor-side"><section className="panel"><span className="section-label">Последняя трассировка</span><h3>Распределение задержки</h3>{latest ? stageMeta.map((stage) => <div className="distribution-row" key={stage.key}><div><span>{stage.label}</span><b>{ms(latest.timings[stage.key])}</b></div><div className="distribution-track"><span className={stage.key === 'route' ? 'highlight' : ''} style={{ width: `${(latest.timings[stage.key] ?? 0) / maxStage * 100}%` }} /></div></div>) : <p className="muted">Нет данных</p>}<p className="muted small">{latest ? `Пример: ${latest.id}. Это не агрегированная метрика.` : 'Ожидание диалога'}</p></section><section className="panel handoff-panel"><span className="section-label">Handoff</span><h3>Передача оператору</h3>{handoff ? <><p>{handoff.handoffReason ?? handoff.route.reason}</p><button className="text-button" onClick={() => onTrace(handoff.id)}>Разобрать диалог ↗</button></> : <p className="muted">Передач оператору пока нет.</p>}</section></div>
    </div>
  </div>
}

const blankScenario: Scenario = { id: '', name: '', description: '', boundaries: [], examplesRu: [], examplesKk: [] }
const listText = (items: string[]) => items.join('\n')
const parseLines = (value: string) => value.split('\n')

function CatalogPage({ scenarios, onSaved }: { scenarios: Scenario[]; onSaved: (scenario: Scenario) => void }) {
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(scenarios[0]?.id ?? null)
  const [form, setForm] = useState<Scenario>(scenarios[0] ?? blankScenario)
  const [isNew, setIsNew] = useState(!scenarios.length)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const filtered = scenarios.filter((item) => `${item.id} ${item.name} ${item.description}`.toLowerCase().includes(search.toLowerCase()))

  function select(item: Scenario) { setSelectedId(item.id); setForm({ ...item }); setIsNew(false); setMessage(''); setError('') }
  function create() { setSelectedId(null); setForm({ ...blankScenario }); setIsNew(true); setMessage(''); setError('') }
  function change<K extends keyof Scenario>(key: K, value: Scenario[K]) { setForm((current) => ({ ...current, [key]: value })) }
  async function save(event: FormEvent) {
    event.preventDefault()
    setMessage('')
    setError('')
    const next: Scenario = {
      ...form,
      id: form.id.trim(),
      name: form.name.trim(),
      description: form.description.trim(),
      boundaries: form.boundaries.map((item) => item.trim()).filter(Boolean),
      examplesRu: form.examplesRu.map((item) => item.trim()).filter(Boolean),
      examplesKk: form.examplesKk.map((item) => item.trim()).filter(Boolean),
    }
    if (!next.id || !next.name || !next.description) { setError('Заполните ID, название и описание.'); return }
    if (!/^[a-z0-9_]+$/.test(next.id)) { setError('ID: только латинские строчные буквы, цифры и _.'); return }
    if (isNew && scenarios.some((item) => item.id === next.id)) { setError('Сценарий с таким ID уже существует.'); return }
    setSaving(true)
    try {
      const saved = await api.saveScenario(next)
      onSaved(saved)
      setSelectedId(saved.id)
      setForm(saved)
      setIsNew(false)
      setMessage('Сценарий сохранён и появился в каталоге.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось сохранить сценарий.') }
    finally { setSaving(false) }
  }
  return <div className="page"><div className="page-heading"><div><span className="eyebrow">KNOWLEDGE BASE / 04</span><h1>Каталог сценариев</h1><p>Границы и примеры помогают роутеру выбрать подходящий сценарий.</p></div><button className="primary-button" onClick={create}>＋ Новый сценарий</button></div>
    <div className="catalog-grid"><section className="panel catalog-list"><div className="panel-top"><span className="section-label">Все сценарии</span><span className="count-pill">{scenarios.length}</span></div><input className="search-input" type="search" placeholder="Поиск по ID, названию, описанию" value={search} onChange={(event) => setSearch(event.target.value)} />{!scenarios.length ? <Empty title="Каталог пуст" detail="Создайте первый сценарий справа." /> : !filtered.length ? <Empty title="Ничего не найдено" detail="Попробуйте другой поисковый запрос." /> : <div className="catalog-items">{filtered.map((item) => <button key={item.id} className={`catalog-item ${selectedId === item.id && !isNew ? 'selected' : ''}`} onClick={() => select(item)}><span className="catalog-item-icon">▤</span><span><strong>{item.name}</strong><small>{item.id}</small><em>{item.description}</em></span><span className="catalog-arrow">›</span></button>)}</div>}</section>
      <section className="panel editor-panel"><div className="panel-top"><div><span className="section-label">{isNew ? 'Создание сценария' : 'Редактор сценария'}</span><h2>{isNew ? 'Новый сценарий' : form.name}</h2></div><Badge tone={isNew ? 'blue' : 'green'}>{isNew ? 'Черновик' : 'В каталоге'}</Badge></div><form onSubmit={(event) => void save(event)}><div className="form-row"><label>ID сценария<input value={form.id} disabled={!isNew} onChange={(event) => change('id', event.target.value)} placeholder="new_scenario_id" /></label><label>Название<input value={form.name} onChange={(event) => change('name', event.target.value)} placeholder="Название сценария" /></label></div><label>Описание<textarea rows={2} value={form.description} onChange={(event) => change('description', event.target.value)} placeholder="Когда этот сценарий подходит" /></label><label>Границы сценария <span>по одной на строку</span><textarea rows={3} value={listText(form.boundaries)} onChange={(event) => change('boundaries', parseLines(event.target.value))} placeholder="Что нельзя обещать клиенту" /></label><div className="form-row"><label>Примеры · RU <span>по одному на строку</span><textarea rows={4} value={listText(form.examplesRu)} onChange={(event) => change('examplesRu', parseLines(event.target.value))} placeholder="Фразы клиента на русском" /></label><label>Примеры · KK <span>по одному на строку</span><textarea rows={4} value={listText(form.examplesKk)} onChange={(event) => change('examplesKk', parseLines(event.target.value))} placeholder="Қазақша мысалдар" /></label></div>{error && <p role="alert" className="form-error">{error}</p>}{message && <p role="status" className="form-success">{message}</p>}<div className="form-footer"><span>{isDemo ? 'Изменения хранятся в этом браузере' : 'Сохранение в backend'}</span><button className="primary-button" disabled={saving} type="submit">{saving ? 'Сохраняем…' : 'Сохранить сценарий'}</button></div></form></section></div>
  </div>
}

export default function App() {
  const [location, setLocation] = useState(window.location.pathname + window.location.search)
  const [scenarios, setScenarios] = useState<Scenario[]>([])
  const [dialogs, setDialogs] = useState<Dialog[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const currentPath = location.split('?')[0]
  const page: Page = isPage(currentPath) ? currentPath : '/call'
  const selectedId = new URLSearchParams(location.split('?')[1] ?? '').get('dialog')

  useEffect(() => {
    const onPop = () => setLocation(window.location.pathname + window.location.search)
    window.addEventListener('popstate', onPop)
    Promise.allSettled([api.listScenarios(), api.listDialogs()]).then(([catalog, history]) => {
      if (catalog.status === 'fulfilled') setScenarios(catalog.value)
      if (history.status === 'fulfilled') setDialogs(history.value)
      if (catalog.status === 'rejected' || history.status === 'rejected') setLoadError('Часть данных backend недоступна. Проверьте сервер и обновите страницу.')
      setLoading(false)
    })
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  function navigate(target: string) {
    window.history.pushState(null, '', target)
    setLocation(target)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  function addDialog(dialog: Dialog) { setDialogs((current) => [dialog, ...current.filter((item) => item.id !== dialog.id)]) }
  function updateScenario(scenario: Scenario) { setScenarios((current) => [scenario, ...current.filter((item) => item.id !== scenario.id)]) }
  const trace = (id: string) => navigate(`/trace?dialog=${encodeURIComponent(id)}`)

  return <div className="app-shell"><header className="app-header"><div className="brand" onClick={() => navigate('/call')} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') navigate('/call') }}><span className="brand-mark"><span>◖</span><span>◗</span></span><span className="brand-name">Tyńda <b>Voice Router</b><small>INTELLIGENT CALL OPERATIONS</small></span></div><nav aria-label="Основная навигация">{pages.map((item) => <button key={item.path} className={page === item.path ? 'active' : ''} onClick={() => navigate(item.path)}><span>{item.icon}</span>{item.label}</button>)}</nav><div className="header-right"><span className="system-dot" /><span>Система готова</span><Badge tone={isDemo ? 'blue' : 'green'}>{isDemo ? 'DEMO' : 'LIVE'}</Badge></div></header><main>{loadError && <div role="alert" className="alert error-alert">{loadError}</div>}{page === '/call' && <CallPage scenarios={scenarios} dialogs={dialogs} onDialog={addDialog} onTrace={trace} />}{page === '/trace' && <TracePage dialogs={dialogs} scenarios={scenarios} selectedId={selectedId} onSelect={trace} />}{page === '/supervisor' && <SupervisorPage dialogs={dialogs} scenarios={scenarios} onTrace={trace} />}{page === '/catalog' && (loading ? <div className="page"><Empty title="Загружаем каталог" detail="Подождите несколько секунд." /></div> : <CatalogPage scenarios={scenarios} onSaved={updateScenario} />)}</main><footer><span>TYŃDA / VOICE ROUTER</span><span>Decision intelligence for every conversation</span><span>{isDemo ? 'DEMO ENVIRONMENT' : 'LIVE ENVIRONMENT'}</span></footer></div>
}
