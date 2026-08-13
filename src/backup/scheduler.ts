// Decyzja „czy teraz robimy backup".
//
// Harmonogram liczy AGENT, nie Lunor — Vercel Hobby tnie cron do 1×/dzień,
// więc Lunor fizycznie nie może być zegarem (spec §3 D4). Bonus: backup
// działa nawet wtedy, gdy Lunor jest chwilowo nieosiągalny.

import type { BackupConfig, BackupState } from './types'

export type Decision =
  | { run: false; reason: string }
  | { run: true; trigger: 'SCHEDULED' | 'MANUAL'; reason: string }

/** Minimalny odstęp między próbami — chroni przed pętlą przy powtarzalnym błędzie. */
export const MIN_RETRY_MINUTES = 30

/**
 * Deterministyczny jitter 0–59 min wyprowadzony z klucza projektu.
 *
 * Bez tego wiele instancji z tą samą polityką uderza w tej samej minucie.
 * Deterministyczny, a nie losowy, żeby restart procesu nie przesuwał okna.
 */
export function jitterMinutes(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0
  }
  return h % 60
}

function hoursBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 3_600_000
}

export function decide(params: {
  config: BackupConfig | null
  state: BackupState
  now: Date
  seed: string
}): Decision {
  const { config, state, now, seed } = params

  if (!config) return { run: false, reason: 'brak konfiguracji' }
  if (!config.enabled) return { run: false, reason: 'backupy wyłączone' }

  // „Uruchom teraz" z panelu ma pierwszeństwo nad harmonogramem, ale tylko raz:
  // po restarcie agenta ten sam znacznik nie może wyzwolić kolejnego zrzutu.
  if (config.runNowRequestedAt && config.runNowRequestedAt !== state.handledRunNowAt) {
    return { run: true, trigger: 'MANUAL', reason: 'żądanie z panelu' }
  }

  // Bufor na powtarzalny błąd: nie próbujemy częściej niż co MIN_RETRY_MINUTES.
  if (state.lastAttemptAt) {
    const sinceAttempt = hoursBetween(new Date(state.lastAttemptAt), now) * 60
    if (sinceAttempt < MIN_RETRY_MINUTES) {
      return { run: false, reason: 'zbyt niedawna próba' }
    }
  }

  // Nigdy nie było udanego backupu → robimy pierwszy od razu, bez czekania na okno.
  if (!state.lastSuccessAt) {
    return { run: true, trigger: 'SCHEDULED', reason: 'brak jakiejkolwiek kopii' }
  }

  const elapsed = hoursBetween(new Date(state.lastSuccessAt), now)
  if (elapsed < config.intervalHours) {
    return { run: false, reason: 'interwał jeszcze nie minął' }
  }

  // Interwał minął. Przy harmonogramie dobowym i rzadszym czekamy dodatkowo na
  // preferowane okno (dump obciąża bazę klienta). Przy gęstszym okno nie ma
  // sensu — trzymałoby backup przez większość doby.
  if (config.intervalHours >= 24) {
    const jitter = jitterMinutes(seed)
    const windowStart = config.preferredHourUtc * 60 + jitter
    const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes()
    const inWindow = minuteOfDay >= windowStart && minuteOfDay < windowStart + 60

    // Zabezpieczenie: jeśli okno przegapione (agent spał), po podwójnym
    // interwale robimy backup niezależnie od godziny. Lepiej o złej porze
    // niż wcale.
    const overdue = elapsed >= config.intervalHours * 2
    if (!inWindow && !overdue) {
      return { run: false, reason: 'poza preferowanym oknem' }
    }
  }

  return { run: true, trigger: 'SCHEDULED', reason: 'interwał minął' }
}
