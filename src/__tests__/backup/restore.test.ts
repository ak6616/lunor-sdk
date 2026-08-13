import { describe, it, expect } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { randomBytes, createHash } from 'node:crypto'
import { buildArtifactStream, MAGIC } from '../../backup/pipeline'
import {
  restoreArtifact,
  InvalidArtifactError,
  ArtifactAuthenticationError,
} from '../../backup/restore'

const KEY = 'a'.repeat(64)
const OTHER_KEY = 'b'.repeat(64)

function collect(): { sink: Writable; chunks: Buffer[] } {
  const chunks: Buffer[] = []
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk))
      cb()
    },
  })
  return { sink, chunks }
}

/** Buduje artefakt z podanych bajtów i zwraca go w całości. */
async function makeArtifact(
  plaintext: Buffer,
  key = KEY,
): Promise<{ artifact: Buffer; checksum: string; sizeBytes: number }> {
  const { stream, result } = buildArtifactStream(
    Readable.from([plaintext]),
    key,
    100 * 1024 * 1024,
  )
  const parts: Buffer[] = []
  for await (const c of stream) parts.push(Buffer.from(c as Buffer))
  const r = await result
  return { artifact: Buffer.concat(parts), checksum: r.checksum, sizeBytes: r.sizeBytes }
}

describe('restoreArtifact — pełny obieg', () => {
  it('odtwarza dokładnie te bajty, które weszły', async () => {
    // 🔴 Najważniejszy test w module. Wszystko inne może być poprawne, a jeśli
    // ten nie przechodzi, backupy są rachunkiem za storage, nie kopią.
    //
    // Dane NIEŚCIŚLIWE (losowe). Powtarzalny wzorzec gzip zgniata ~100:1,
    // co raz już unieważniło pomiar w tym projekcie — tu zafałszowałoby
    // strumieniowość, bo cały artefakt zmieściłby się w jednym chunku.
    const plaintext = randomBytes(3 * 1024 * 1024)
    const { artifact, checksum } = await makeArtifact(plaintext)

    const { sink, chunks } = collect()
    const result = await restoreArtifact({
      source: Readable.from([artifact]),
      encryptionKeyHex: KEY,
      sink,
      expectedChecksum: checksum,
    })

    expect(Buffer.concat(chunks).equals(plaintext)).toBe(true)
    expect(result.plaintextBytes).toBe(plaintext.length)
    expect(result.checksum).toBe(checksum)
    expect(result.sizeBytes).toBe(artifact.length)
  })

  it('odtwarza realistyczny zrzut SQL', async () => {
    const sql = Buffer.from(
      [
        '--',
        '-- PostgreSQL database dump',
        '--',
        'CREATE TABLE public.zamowienia (id integer NOT NULL, klient text);',
        "INSERT INTO public.zamowienia VALUES (1, 'Kowalski');",
        "INSERT INTO public.zamowienia VALUES (2, 'Nowak');",
        '',
      ].join('\n'),
      'utf8',
    )
    const { artifact } = await makeArtifact(sql)
    const { sink, chunks } = collect()
    await restoreArtifact({ source: Readable.from([artifact]), encryptionKeyHex: KEY, sink })
    expect(Buffer.concat(chunks).toString('utf8')).toBe(sql.toString('utf8'))
  })

  it('działa przy strumieniu pociętym na drobne kawałki', async () => {
    // Sieć nie dostarcza artefaktu jednym chunkiem. Rozcinanie nagłówka
    // i ogona między kawałki to dokładnie ten przypadek, w którym naiwne
    // buforowanie się wywraca.
    const plaintext = randomBytes(200 * 1024)
    const { artifact } = await makeArtifact(plaintext)

    const pieces: Buffer[] = []
    for (let i = 0; i < artifact.length; i += 7) {
      pieces.push(artifact.subarray(i, Math.min(i + 7, artifact.length)))
    }

    const { sink, chunks } = collect()
    await restoreArtifact({ source: Readable.from(pieces), encryptionKeyHex: KEY, sink })
    expect(Buffer.concat(chunks).equals(plaintext)).toBe(true)
  })

  it('radzi sobie z pustym zrzutem', async () => {
    const { artifact } = await makeArtifact(Buffer.alloc(0))
    const { sink, chunks } = collect()
    const r = await restoreArtifact({
      source: Readable.from([artifact]),
      encryptionKeyHex: KEY,
      sink,
    })
    expect(Buffer.concat(chunks).length).toBe(0)
    expect(r.plaintextBytes).toBe(0)
  })

  it('tryb weryfikacji nie zapisuje nic, a i tak dowodzi odtwarzalności', async () => {
    // To ma chodzić regularnie — dowód, że kopia jest odczytywalna TYM
    // kluczem, bez stawiania bazy i bez miejsca na dysku.
    const plaintext = randomBytes(64 * 1024)
    const { artifact, checksum } = await makeArtifact(plaintext)
    const r = await restoreArtifact({
      source: Readable.from([artifact]),
      encryptionKeyHex: KEY,
      expectedChecksum: checksum,
    })
    expect(r.plaintextBytes).toBe(plaintext.length)
  })
})

describe('restoreArtifact — wykrywanie uszkodzeń', () => {
  it('zły klucz daje czytelny błąd, a nie „unsupported state"', async () => {
    const { artifact } = await makeArtifact(randomBytes(4096))
    await expect(
      restoreArtifact({ source: Readable.from([artifact]), encryptionKeyHex: OTHER_KEY }),
    ).rejects.toBeInstanceOf(ArtifactAuthenticationError)
  })

  it('przestawiony bajt w szyfrogramie jest wykrywany', async () => {
    // Tego właśnie pilnuje GCM: cicha korupcja jest gorsza niż brak kopii,
    // bo odkrywa się ją przy odtwarzaniu po awarii.
    const { artifact } = await makeArtifact(randomBytes(4096))
    const uszkodzony = Buffer.from(artifact)
    uszkodzony[Math.floor(uszkodzony.length / 2)] ^= 0xff
    await expect(
      restoreArtifact({ source: Readable.from([uszkodzony]), encryptionKeyHex: KEY }),
    ).rejects.toBeInstanceOf(ArtifactAuthenticationError)
  })

  it('naruszony znacznik uwierzytelniający jest wykrywany', async () => {
    const { artifact } = await makeArtifact(randomBytes(4096))
    const uszkodzony = Buffer.from(artifact)
    uszkodzony[uszkodzony.length - 1] ^= 0x01
    await expect(
      restoreArtifact({ source: Readable.from([uszkodzony]), encryptionKeyHex: KEY }),
    ).rejects.toBeInstanceOf(ArtifactAuthenticationError)
  })

  it('obcięty plik daje błąd o obcięciu, a nie o kluczu', async () => {
    const { artifact } = await makeArtifact(randomBytes(4096))
    await expect(
      restoreArtifact({
        source: Readable.from([artifact.subarray(0, artifact.length - 8)]),
        encryptionKeyHex: KEY,
      }),
    ).rejects.toBeInstanceOf(ArtifactAuthenticationError)
  })

  it('cudzy plik jest odrzucany po magii, zanim cokolwiek się zacznie', async () => {
    const obcy = Buffer.concat([Buffer.from('NIE-LUNOR'), randomBytes(1000)])
    await expect(
      restoreArtifact({ source: Readable.from([obcy]), encryptionKeyHex: KEY }),
    ).rejects.toBeInstanceOf(InvalidArtifactError)
  })

  it('plik krótszy niż nagłówek nie zawiesza odtwarzania', async () => {
    // Bez wyścigu z `close` `await` na nagłówek wisiałby w nieskończoność.
    await expect(
      restoreArtifact({ source: Readable.from([MAGIC.subarray(0, 4)]), encryptionKeyHex: KEY }),
    ).rejects.toBeInstanceOf(InvalidArtifactError)
  })

  it('pusty plik daje czytelny błąd', async () => {
    await expect(
      restoreArtifact({ source: Readable.from([]), encryptionKeyHex: KEY }),
    ).rejects.toBeInstanceOf(InvalidArtifactError)
  })

  it('rozjazd sumy kontrolnej jest błędem, gdy oczekiwana jest podana', async () => {
    const { artifact } = await makeArtifact(randomBytes(4096))
    await expect(
      restoreArtifact({
        source: Readable.from([artifact]),
        encryptionKeyHex: KEY,
        expectedChecksum: 'deadbeef'.repeat(8),
      }),
    ).rejects.toThrow(/Suma kontrolna/)
  })

  it('🔴 błąd źródła PRZED nagłówkiem nie ubija procesu', async () => {
    // Fail-open. Zanim nagłówek się pojawi, potok nie jest jeszcze spięty
    // przez `pipeline()`, więc `error` na źródle nie ma kto obsłużyć —
    // a zdarzenie `error` bez słuchacza to w Node niewyłapany wyjątek.
    // `restoreArtifact` jest wystawiony jako funkcja biblioteczna, więc
    // taki błąd zabiłby proces aplikacji, która go woła.
    //
    // Regresja z 2026-08-13: wykryta przez test CLI „nieistniejący plik",
    // bo `createReadStream` na brakującym pliku zgłasza ENOENT właśnie tutaj.
    const zrodlo = new Readable({
      read() {
        this.destroy(new Error('padło przed nagłówkiem'))
      },
    })
    await expect(
      restoreArtifact({ source: zrodlo, encryptionKeyHex: KEY }),
    ).rejects.toThrow(/padło przed nagłówkiem/)
  })

  it('🔴 błąd źródła W TRAKCIE strumienia też wraca przez odrzucenie', async () => {
    const { artifact } = await makeArtifact(randomBytes(256 * 1024))
    let wyslane = 0
    const zrodlo = new Readable({
      read() {
        if (wyslane >= artifact.length / 2) {
          this.destroy(new Error('sieć padła w połowie'))
          return
        }
        this.push(artifact.subarray(wyslane, wyslane + 4096))
        wyslane += 4096
      },
    })
    await expect(
      restoreArtifact({ source: zrodlo, encryptionKeyHex: KEY }),
    ).rejects.toThrow(/sieć padła/)
  })

  it('zły format klucza jest odrzucany przed dotknięciem pliku', async () => {
    await expect(
      restoreArtifact({ source: Readable.from([Buffer.alloc(0)]), encryptionKeyHex: 'krótki' }),
    ).rejects.toThrow(/64-znakowym hexem/)
  })
})

describe('zgodność z formatem zapisanym w pipeline', () => {
  it('artefakt zaczyna się magią i IV o znanych długościach', async () => {
    const { artifact } = await makeArtifact(Buffer.from('x'))
    expect(artifact.subarray(0, 8).equals(MAGIC)).toBe(true)
    // 8B magia + 12B IV + szyfrogram + 16B tag
    expect(artifact.length).toBeGreaterThan(8 + 12 + 16)
  })

  it('suma kontrolna z agenta obejmuje CAŁY artefakt razem z nagłówkiem', async () => {
    // Gdyby agent liczył sumę tylko z szyfrogramu, weryfikacja po stronie
    // odtwarzania nigdy by się nie zgodziła — a rozjazd wyszedłby dopiero
    // przy pierwszej prawdziwej awarii.
    const { artifact, checksum } = await makeArtifact(randomBytes(8192))
    expect(createHash('sha256').update(artifact).digest('hex')).toBe(checksum)
  })
})
