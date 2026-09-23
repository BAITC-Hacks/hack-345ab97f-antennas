import { mockApi } from './mockApi'
import { realApi } from './realApi'

export const isDemo = import.meta.env.VITE_DEMO_MODE === 'true'
export const api = isDemo ? mockApi : realApi
