export type Language = 'ru' | 'kk' | 'mixed'
export type Decision = 'route' | 'continue' | 'clarify' | 'handoff' | 'out_of_scope'
export type CallStatus = 'ready' | 'connecting' | 'listening' | 'recognizing' | 'thinking' | 'speaking' | 'completed' | 'error' | 'disconnected'

export interface Transcript {
  turnId: string
  text: string
  lang: Language
  isFinal: boolean
}

export interface RouteDecision {
  turnId: string
  scenarioId: string | null
  decision: Decision
  confidence: number | null
  path: 'llm' | 'fast'
  reason: string
  topicSwitch?: boolean
  additionalIntents: Array<{ scenarioId: string; confidence: number | null }>
  alternatives: Array<{ scenarioId: string; confidence: number | null; whyNot?: string }>
}

export interface TraceTimings {
  endpoint?: number
  stt?: number
  route?: number
  exec?: number
  firstAudio?: number
  playback?: number
  total?: number
}

export interface Scenario {
  id: string
  name: string
  description: string
  boundaries: string[]
  examplesRu: string[]
  examplesKk: string[]
}

export interface Dialog {
  id: string
  createdAt: string
  status: 'completed' | 'handoff' | 'error'
  transcript: Transcript
  route: RouteDecision
  timings: TraceTimings
  reply: string
  handoffReason?: string
  ttsUrl?: string
}

export type CallEvent =
  | { type: 'status'; status: CallStatus }
  | { type: 'transcript'; transcript: Transcript }
  | { type: 'route'; route: RouteDecision }
  | { type: 'reply'; text: string; ttsUrl?: string }
  | { type: 'tts_audio'; format: 'wav'; chunk: string }
  | { type: 'error'; message: string }
  | { type: 'disconnected'; message: string }

export interface VoiceRouterApi {
  listScenarios(): Promise<Scenario[]>
  saveScenario(scenario: Scenario): Promise<Scenario>
  listDialogs(): Promise<Dialog[]>
  getDialog(id: string): Promise<Dialog | null>
  startCall(): Promise<string>
  submitText(callId: string, text: string, onEvent: (event: CallEvent) => void, signal?: AbortSignal): Promise<Dialog>
  submitAudio?(callId: string, pcm16: Uint8Array, onEvent: (event: CallEvent) => void, signal?: AbortSignal): Promise<Dialog>
  endCall(callId: string): Promise<void>
}
