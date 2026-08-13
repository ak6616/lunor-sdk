// Trwały stan agenta backupu.
//
// Musi przeżyć restart procesu: RPi Lastorii restartuje się w nocy, a stan
// wyłącznie w pamięci oznaczałby backup przy każdym starcie (albo żaden).
// Ten sam powód, dla którego blocklista firewalla ma snapshot na dysku.
//
// `node:fs` importowany STATYCZNIE — runtime `require('node:fs')` przechodził
// guard `typeof require`, ale wywalał się przy wywołaniu w buildzie ESM
// („Dynamic require of fs is not supported"), przez co snapshot był martwy
// na Lastorii (incydent 2026-07-06).

import fs from 'node:fs'
import type { BackupState } from './types'

export const EMPTY_STATE: BackupState = {
  lastSuccessAt: null,
  lastAttemptAt: null,
  handledRunNowAt: null,
}

export class BackupStateStore {
  private state: BackupState = { ...EMPTY_STATE }

  constructor(
    private path?: string,
    private logger?: (msg: string, err?: unknown) => void,
  ) {
    this.load()
  }

  get(): BackupState {
    return { ...this.state }
  }

  /** Scala i zapisuje. Błąd zapisu nie jest fatalny — gorszy stan, nie awaria. */
  update(patch: Partial<BackupState>): void {
    this.state = { ...this.state, ...patch }
    this.save()
  }

  private load(): void {
    if (!this.path) return
    try {
      if (!fs.existsSync(this.path)) return
      const parsed = JSON.parse(fs.readFileSync(this.path, 'utf8')) as Partial<BackupState>
      // Nie ufamy zawartości pliku — bierzemy tylko pola, które rozumiemy.
      this.state = {
        lastSuccessAt: typeof parsed.lastSuccessAt === 'string' ? parsed.lastSuccessAt : null,
        lastAttemptAt: typeof parsed.lastAttemptAt === 'string' ? parsed.lastAttemptAt : null,
        handledRunNowAt:
          typeof parsed.handledRunNowAt === 'string' ? parsed.handledRunNowAt : null,
      }
    } catch (err) {
      this.logger?.('[lunor:backup] nie udało się wczytać stanu (startuję od zera)', err)
    }
  }

  private save(): void {
    if (!this.path) return
    try {
      fs.writeFileSync(this.path, JSON.stringify(this.state), 'utf8')
    } catch (err) {
      this.logger?.('[lunor:backup] nie udało się zapisać stanu (ignoruję)', err)
    }
  }
}
