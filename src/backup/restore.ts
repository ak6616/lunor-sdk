// Odtwarzanie artefaktu — dokładna odwrotność `pipeline.ts`.
//
// 🔴 To jest część modułu, która decyduje, czy backupy w ogóle mają wartość.
// Kopia, której nie umiesz odtworzyć, nie jest kopią, tylko rachunkiem za
// storage. Dlatego odtwarzanie jest wydanym narzędziem, a nie doraźnym
// skryptem odtwarzanym z pamięci w dniu awarii.
//
// Format (patrz `pipeline.ts`):
//
//   [ 8B magia "LUNORBK1" ][ 12B IV ][ ...szyfrogram... ][ 16B authTag ]
//
// Dwie rzeczy czynią to trudniejszym, niż wygląda:
//
// 1. **authTag jest na KOŃCU pliku, a `setAuthTag()` musi paść PRZED
//    `final()`.** Przy odczycie strumieniowym nie wiadomo z góry, które bajty
//    są ostatnie — więc trzeba stale wstrzymywać ostatnie 16 bajtów i oddać je
//    deszyfratorowi dopiero, gdy źródło się skończy. Naiwne „przepuść
//    wszystko, potem ustaw tag" kończy się `Unsupported state or unable to
//    authenticate data`, co wygląda na zły klucz, a jest błędem sterowania.
//
// 2. **Wszystko musi zostać strumieniowe.** Artefakt to cała baza klienta;
//    wczytanie go do pamięci przy odtwarzaniu przewróciłoby dokładnie te
//    maszyny, dla których backup powstał.

import { createDecipheriv, createHash, type DecipherGCM } from 'node:crypto'
import { createGunzip } from 'node:zlib'
import { Transform, type Readable, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { MAGIC, parseEncryptionKey } from './pipeline'

const IV_BYTES = 12
const AUTH_TAG_BYTES = 16
const HEADER_BYTES = MAGIC.length + IV_BYTES

export class InvalidArtifactError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidArtifactError'
  }
}

export class ArtifactAuthenticationError extends Error {
  constructor() {
    super(
      'Nie udało się uwierzytelnić artefaktu. Najczęstsze przyczyny: ' +
        'zły klucz szyfrujący albo uszkodzony/obcięty plik.',
    )
    this.name = 'ArtifactAuthenticationError'
  }
}

/**
 * Jeden Transform robiący całe odszyfrowanie: nagłówek → deszyfrator → ogon.
 *
 * Dlaczego wszystko w JEDNEJ klasie, skoro naturalniej byłoby rozciąć strumień
 * i wpiąć osobny `createDecipheriv` obok? Bo deszyfrator potrzebuje IV, które
 * poznajemy dopiero z pierwszych bajtów — więc nie da się go stworzyć przed
 * uruchomieniem potoku, a `pipeline()` wymaga kompletu strumieni z góry.
 * Pierwsza wersja obchodziła to czekaniem na zdarzenie `header` i spinaniem
 * `pipeline()` dopiero potem, od środka łańcucha. Miało to defekt: `.pipe()`
 * NIE propaguje błędów, więc padnięcie źródła w połowie (zerwane pobieranie)
 * nie docierało do `pipeline()` i odtwarzanie wisiało w nieskończoność.
 *
 * Trzymanie deszyfratora w środku pozwala złożyć cały potok od razu — razem
 * ze źródłem — i oddać obsługę błędów `pipeline()`, czyli jedynemu miejscu
 * w Node, które robi to poprawnie.
 */
class DecryptTransform extends Transform {
  private buf: Buffer = Buffer.alloc(0)
  private decipher: DecipherGCM | null = null

  constructor(private readonly key: Buffer) {
    super()
  }

  _transform(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.buf = Buffer.concat([this.buf, chunk])

    if (!this.decipher) {
      if (this.buf.length < HEADER_BYTES) {
        cb()
        return
      }
      const magic = this.buf.subarray(0, MAGIC.length)
      if (!magic.equals(MAGIC)) {
        cb(
          new InvalidArtifactError(
            `To nie jest artefakt Lunora — oczekiwano magii ${JSON.stringify(
              MAGIC.toString('utf8'),
            )}, jest ${JSON.stringify(magic.toString('utf8').replace(/[^\x20-\x7e]/g, '?'))}.`,
          ),
        )
        return
      }
      const iv = this.buf.subarray(MAGIC.length, HEADER_BYTES)
      this.decipher = createDecipheriv('aes-256-gcm', this.key, iv)
      this.buf = this.buf.subarray(HEADER_BYTES)
    }

    // Wstrzymujemy ostatnie AUTH_TAG_BYTES bajtów: dopóki źródło płynie, nie
    // wiadomo, czy właśnie te są znacznikiem uwierzytelniającym. `setAuthTag()`
    // musi paść PRZED `final()`, a tag leży na końcu pliku — bez wstrzymywania
    // nie da się tego pogodzić.
    if (this.buf.length > AUTH_TAG_BYTES) {
      const ciphertext = this.buf.subarray(0, this.buf.length - AUTH_TAG_BYTES)
      this.buf = this.buf.subarray(this.buf.length - AUTH_TAG_BYTES)
      try {
        this.push(this.decipher.update(ciphertext))
      } catch (err) {
        cb(err as Error)
        return
      }
    }
    cb()
  }

  _flush(cb: (e?: Error | null) => void): void {
    if (!this.decipher) {
      cb(
        new InvalidArtifactError(
          `Artefakt jest krótszy niż nagłówek (${HEADER_BYTES} B) — plik jest obcięty albo pusty.`,
        ),
      )
      return
    }
    if (this.buf.length !== AUTH_TAG_BYTES) {
      cb(
        new InvalidArtifactError(
          `Artefakt jest obcięty: zostało ${this.buf.length} B zamiast ${AUTH_TAG_BYTES} B znacznika uwierzytelniającego.`,
        ),
      )
      return
    }
    try {
      this.decipher.setAuthTag(this.buf)
      this.push(this.decipher.final())
      cb()
    } catch {
      // GCM nie odróżnia „zły klucz" od „podmienione bajty" — i nie powinien.
      cb(new ArtifactAuthenticationError())
    }
  }
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

export interface RestoreResult {
  /** sha256 CAŁEGO artefaktu — porównywalny z `BackupRun.checksum`. */
  checksum: string
  /** Rozmiar artefaktu w bajtach. */
  sizeBytes: number
  /** Bajty zrzutu SQL po odszyfrowaniu i dekompresji. */
  plaintextBytes: number
}

export interface RestoreOptions {
  /** Strumień artefaktu (plik, odpowiedź HTTP). */
  source: Readable
  /** Klucz szyfrujący — ten sam hex, którym artefakt powstał. */
  encryptionKeyHex: string
  /**
   * Dokąd trafia odszyfrowany zrzut SQL. Pominięcie = tryb weryfikacji:
   * artefakt jest w pełni odszyfrowany i sprawdzony, ale nigdzie nie zapisany.
   */
  sink?: Writable
  /** Jeśli podany, rozjazd sumy kontrolnej jest błędem. */
  expectedChecksum?: string
}

/**
 * Odszyfrowuje i dekompresuje artefakt, pisząc zrzut SQL do `sink`.
 *
 * Bez `sink` działa jako **weryfikacja**: przepuszcza całość przez deszyfrator
 * i gunzip, więc dowodzi, że plik jest odtwarzalny tym kluczem — nie zapisując
 * ani bajtu. To jest test, który powinien chodzić regularnie, a nie w dniu
 * awarii.
 */
export async function restoreArtifact(opts: RestoreOptions): Promise<RestoreResult> {
  const key = parseEncryptionKey(opts.encryptionKeyHex)
  const hash = createHash('sha256')

  let sizeBytes = 0
  let plaintextBytes = 0

  const counter = new Transform({
    transform(chunk, _enc, cb) {
      sizeBytes += chunk.length
      cb(null, chunk)
    },
  })

  const sink =
    opts.sink ??
    new Transform({
      transform(_chunk, _enc, cb) {
        cb() // tryb weryfikacji — bajty przepływają i giną
      },
    })

  const counted = new Transform({
    transform(chunk, _enc, cb) {
      plaintextBytes += chunk.length
      cb(null, chunk)
    },
  })

  // JEDEN `pipeline()` obejmujący CAŁY łańcuch razem ze źródłem.
  //
  // 🔴 To nie jest kwestia stylu. `.pipe()` nie propaguje błędów, więc gdy
  // potok startował od środka łańcucha (tak było w pierwszej wersji), padnięcie
  // źródła w połowie — czyli zerwane pobieranie artefaktu — nie docierało
  // nigdzie i odtwarzanie wisiało w nieskończoność. `pipeline()` propaguje
  // błędy w obie strony i sprząta wszystkie strumienie, także te, których
  // wywołujący nie widzi.
  //
  // Hasz i licznik siedzą PRZED odszyfrowaniem, żeby suma kontrolna obejmowała
  // cały artefakt — dokładnie te bajty, które policzył agent.
  try {
    await pipeline(
      opts.source,
      hasher(hash),
      counter,
      new DecryptTransform(key),
      createGunzip(),
      counted,
      sink,
    )
  } catch (err) {
    if (err instanceof InvalidArtifactError || err instanceof ArtifactAuthenticationError) {
      throw err
    }
    const message = err instanceof Error ? err.message : String(err)
    // Node zgłasza nieudane uwierzytelnienie GCM tym komunikatem. Bez tłumaczenia
    // użytkownik widzi „unsupported state" i szuka błędu w kodzie, a nie w kluczu.
    if (/unable to authenticate|unsupported state/i.test(message)) {
      throw new ArtifactAuthenticationError()
    }
    throw err
  }

  const checksum = hash.digest('hex')
  if (opts.expectedChecksum && opts.expectedChecksum !== checksum) {
    throw new InvalidArtifactError(
      `Suma kontrolna się nie zgadza: oczekiwano ${opts.expectedChecksum}, policzono ${checksum}. ` +
        `Artefakt jest uszkodzony albo podmieniony.`,
    )
  }

  return { checksum, sizeBytes, plaintextBytes }
}
