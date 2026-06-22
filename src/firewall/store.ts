import { signRequest } from '../hmac'
import { HEADER_API_KEY } from '../constants'
import type { BlockEntryLite } from './matcher'

export interface FirewallState {
  mode: 'OFF' | 'MONITOR' | 'ENFORCE'
  entries: BlockEntryLite[]
  fetchedAt: number
}

export interface StoreOptions {
  apiKey: string
  apiSecret: string
  blocklistUrl: string
  pollIntervalMs?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
  snapshotPath?: string
  logger?: (msg: string, err?: unknown) => void
}

const DEFAULT_POLL = 45000
const DEFAULT_TIMEOUT = 3000
const MAX_BACKOFF = 300000 // 5 min

export class BlocklistStore {
  private opts: StoreOptions
  private state: FirewallState | null = null
  private etag: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private consecutiveErrors = 0
  private fetchImpl: typeof fetch
  private log: (msg: string, err?: unknown) => void

  constructor(opts: StoreOptions) {
    this.opts = opts
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
    this.log = opts.logger ?? ((m, e) => console.warn('[Lunor firewall] ' + m, e ?? ''))
    // Zimny start: spróbuj wczytać snapshot z dysku (jeśli skonfigurowany).
    this.loadSnapshot()
  }

  getState(): FirewallState | null {
    return this.state
  }

  start(): void {
    if (this.timer) return
    // Pierwsze pobranie od razu (w tle), potem wg interwału/backoffu.
    void this.tick()
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private scheduleNext(): void {
    const base = this.opts.pollIntervalMs ?? DEFAULT_POLL
    const delay =
      this.consecutiveErrors === 0
        ? base
        : Math.min(base * 2 ** this.consecutiveErrors, MAX_BACKOFF)
    this.timer = setTimeout(() => void this.tick(), delay)
    // Nie blokuj procesu klienta tym timerem.
    if (typeof (this.timer as any)?.unref === 'function') (this.timer as any).unref()
  }

  private async tick(): Promise<void> {
    await this.refreshOnce()
    this.scheduleNext()
  }

  // Jedno pobranie. NIGDY nie rzuca (fail-open). Aktualizuje cache tylko przy 200.
  async refreshOnce(): Promise<void> {
    const controller = new AbortController()
    const to = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? DEFAULT_TIMEOUT)
    try {
      const auth = await signRequest(this.opts.apiSecret, '')
      const headers: Record<string, string> = {
        [HEADER_API_KEY]: this.opts.apiKey,
        ...auth,
      }
      if (this.etag) headers['If-None-Match'] = this.etag

      const res = await this.fetchImpl(this.opts.blocklistUrl, {
        method: 'GET',
        headers,
        signal: controller.signal,
      })

      if (res.status === 304) {
        this.consecutiveErrors = 0
        return
      }
      if (!res.ok) {
        this.consecutiveErrors++
        this.log(`blocklist poll status ${res.status}`)
        return
      }

      const body = (await res.json()) as { mode: FirewallState['mode']; entries: BlockEntryLite[] }
      const newEtag = res.headers.get('ETag')
      this.state = { mode: body.mode, entries: body.entries ?? [], fetchedAt: Date.now() }
      this.etag = newEtag
      this.consecutiveErrors = 0
      this.saveSnapshot()
    } catch (err) {
      this.consecutiveErrors++
      this.log('blocklist poll failed (fail-open, zachowuję cache)', err)
    } finally {
      clearTimeout(to)
    }
  }

  // ---- Snapshot na dysku (opcjonalny; tylko długo-żyjące procesy / pizza) ----
  // Guard `typeof require` — build ESM (tsup) nie ma `require`; tam snapshot
  // jest po prostu nieaktywny (fail-open), zamiast rzucać ReferenceError.
  private loadSnapshot(): void {
    if (!this.opts.snapshotPath || typeof require !== 'function') return
    try {
      const fs = require('node:fs') as typeof import('node:fs')
      if (!fs.existsSync(this.opts.snapshotPath)) return
      const raw = fs.readFileSync(this.opts.snapshotPath, 'utf8')
      const snap = JSON.parse(raw) as FirewallState
      if (snap && snap.mode && Array.isArray(snap.entries)) {
        this.state = snap
      }
    } catch (err) {
      this.log('nie udało się wczytać snapshotu (ignoruję)', err)
    }
  }

  private saveSnapshot(): void {
    if (!this.opts.snapshotPath || !this.state || typeof require !== 'function') return
    try {
      const fs = require('node:fs') as typeof import('node:fs')
      fs.writeFileSync(this.opts.snapshotPath, JSON.stringify(this.state), 'utf8')
    } catch (err) {
      this.log('nie udało się zapisać snapshotu (ignoruję)', err)
    }
  }
}
