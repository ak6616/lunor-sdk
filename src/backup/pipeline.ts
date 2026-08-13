// Pipeline artefaktu: surowy zrzut → gzip → AES-256-GCM → sha256 → wysyłka.
//
// Wszystko STRUMIENIOWO. Zrzut bazy nigdy nie ląduje w całości w pamięci —
// RPi Lastorii ma jej mało, a dump rośnie z zamówieniami.
//
// Format artefaktu (bez tego odtworzenie jest niemożliwe):
//
//   [ 8B magia "LUNORBK1" ][ 12B IV ][ ...szyfrogram... ][ 16B authTag ]
//
// IV i authTag MUSZĄ podróżować razem z danymi. Pominięcie ich to najczęstszy
// błąd domowych schematów szyfrowania — plik wygląda poprawnie, a nie da się
// go odszyfrować.

import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { createGzip } from 'node:zlib'
import { Transform, type Readable } from 'node:stream'

export const MAGIC = Buffer.from('LUNORBK1', 'utf8')
const IV_BYTES = 12
const AUTH_TAG_BYTES = 16

export class BackupSizeExceededError extends Error {
  constructor(limitBytes: number) {
    super(`Artefakt przekroczył limit ${limitBytes} B — przerwano`)
    this.name = 'BackupSizeExceededError'
  }
}

export class InvalidEncryptionKeyError extends Error {
  constructor() {
    super('encryptionKey musi być 64-znakowym hexem (32 bajty)')
    this.name = 'InvalidEncryptionKeyError'
  }
}

export function parseEncryptionKey(hex: string): Buffer {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new InvalidEncryptionKeyError()
  }
  return Buffer.from(hex, 'hex')
}

/**
 * Odcisk klucza do porównania z tym, czego spodziewa się Lunor.
 * Sam klucz nigdy nie opuszcza maszyny klienta — wysyłamy wyłącznie odcisk.
 */
export function keyFingerprint(hex: string): string {
  return createHash('sha256').update(parseEncryptionKey(hex)).digest('hex').slice(0, 16)
}

export interface PipelineResult {
  /** Rozmiar gotowego artefaktu w bajtach (po szyfrowaniu). */
  sizeBytes: number
  /** sha256 artefaktu — tego, co realnie poszło do storage. */
  checksum: string
}

/**
 * Licznik bajtów z twardym limitem. Limit przerywa pipeline zamiast wysyłać
 * obcięty plik — lepszy jawny błąd niż kopia, której nie da się odtworzyć.
 */
function limiter(limitBytes: number, onTotal: (n: number) => void): Transform {
  let total = 0
  return new Transform({
    transform(chunk, _enc, cb) {
      total += chunk.length
      if (total > limitBytes) {
        cb(new BackupSizeExceededError(limitBytes))
        return
      }
      onTotal(total)
      cb(null, chunk)
    },
  })
}

/** Liczy sha256 przepływających bajtów, nie zmieniając ich. */
function hasher(hash: ReturnType<typeof createHash>): Transform {
  return new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk)
      cb(null, chunk)
    },
  })
}

/**
 * Buduje strumień artefaktu ze strumienia surowego zrzutu.
 *
 * Zwraca strumień do wysyłki oraz `result`, które rozstrzyga się dopiero po
 * przepłynięciu wszystkich bajtów (checksum i rozmiar znamy na końcu, nie na
 * starcie — dlatego meldunek do Lunora idzie po uploadzie).
 */
export function buildArtifactStream(
  source: Readable,
  encryptionKeyHex: string,
  maxSizeBytes: number,
): { stream: Readable; result: Promise<PipelineResult> } {
  const key = parseEncryptionKey(encryptionKeyHex)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const hash = createHash('sha256')

  let sizeBytes = 0
  let settle: (r: PipelineResult) => void
  let fail: (e: unknown) => void
  const result = new Promise<PipelineResult>((res, rej) => {
    settle = res
    fail = rej
  })

  // 🔴 Fail-open: oznaczamy odrzucenie jako obsłużone od razu.
  //
  // Bez tego wystarczy, że upload wywali się pierwszy (bo strumień padł) i nikt
  // nie zdąży zaczekać na `result` — wtedy jego odrzucenie jest NIEOBSŁUŻONE
  // i w procesie aplikacji klienta ląduje `unhandledRejection`. Agent backupu
  // nie ma prawa niczego takiego robić hostowi.
  //
  // Doczepienie własnego `catch` nie „zjada" błędu wołającemu: `await result`
  // w innym miejscu nadal rzuci.
  void result.catch(() => {})

  // Ręczne składanie zamiast `pipeline()`: nagłówek i authTag trzeba wstrzyknąć
  // przed i po szyfrogramie, a authTag jest znany dopiero po `cipher.final()`.
  const out = new Transform({ transform: (c, _e, cb) => cb(null, c) })

  // 🔴 Fail-open, druga odsłona: strumień zniszczony błędem emituje `error`,
  // a zdarzenie `error` BEZ słuchacza to w Node niewyłapany wyjątek — czyli
  // potencjalnie ubity proces aplikacji klienta. Konsument (fetch) i tak
  // zobaczy zniszczony strumień, a błąd wraca wołającemu przez `result`;
  // ten słuchacz istnieje wyłącznie po to, żeby nic nie wyleciało w górę.
  out.on('error', () => {})

  out.push(MAGIC)
  out.push(iv)
  sizeBytes = MAGIC.length + iv.length
  hash.update(MAGIC)
  hash.update(iv)

  const gzip = createGzip()
  const limit = limiter(maxSizeBytes, () => {})
  const count = new Transform({
    transform(chunk, _enc, cb) {
      sizeBytes += chunk.length
      hash.update(chunk)
      cb(null, chunk)
    },
  })

  const onError = (err: unknown) => {
    fail(err)
    out.destroy(err instanceof Error ? err : new Error(String(err)))
  }

  source.on('error', onError)
  gzip.on('error', onError)
  cipher.on('error', onError)
  limit.on('error', onError)

  cipher.on('end', () => {
    try {
      const tag = cipher.getAuthTag()
      sizeBytes += tag.length
      hash.update(tag)
      out.end(tag)
      settle({ sizeBytes, checksum: hash.digest('hex') })
    } catch (err) {
      onError(err)
    }
  })

  // gzip przed szyfrowaniem — szyfrogram jest nieściśliwy, odwrotna kolejność
  // nic by nie dała. Limit liczy bajty PO szyfrowaniu, czyli to, co poleci
  // do storage i zajmie miejsce.
  source.pipe(gzip).pipe(cipher).pipe(limit).pipe(count)
  count.on('data', (c) => out.write(c))
  count.on('error', onError)

  return { stream: out as unknown as Readable, result }
}
