import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { parseArgs, resolveKey, main } from '../../backup/cli'
import { buildArtifactStream } from '../../backup/pipeline'

const KEY = 'a'.repeat(64)
const OTHER_KEY = 'b'.repeat(64)

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lunor-cli-'))
  // CLI pisze do stderr/stdout — wyciszamy, żeby nie zaśmiecać wyjścia testów.
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function writeArtifact(plaintext: Buffer, key = KEY): Promise<{ path: string; checksum: string }> {
  const { stream, result } = buildArtifactStream(Readable.from([plaintext]), key, 50 * 1024 * 1024)
  const parts: Buffer[] = []
  for await (const c of stream) parts.push(Buffer.from(c as Buffer))
  const r = await result
  const path = join(dir, 'artefakt.dump.gz.enc')
  writeFileSync(path, Buffer.concat(parts))
  return { path, checksum: r.checksum }
}

describe('parseArgs', () => {
  it('czyta komendę i opcje', () => {
    const a = parseArgs(['restore', '--in', 'x.enc', '--out', 'y.sql', '--checksum', 'abc'])
    expect(a).toMatchObject({ command: 'restore', in: 'x.enc', out: 'y.sql', checksum: 'abc' })
  })

  it('🔴 ODMAWIA przyjęcia klucza przez argv', () => {
    // Argumenty procesu widzi w `ps` każdy użytkownik maszyny, a ten klucz
    // otwiera WSZYSTKIE kopie projektu — jest wrażliwszy niż hasło do bazy,
    // które silnik zrzutu już z argv trzyma z daleka. Cicha akceptacja
    // `--key` zniweczyłaby tamto zabezpieczenie.
    expect(() => parseArgs(['verify', '--in', 'x', '--key', KEY])).toThrow(/ps/)
  })

  it('nieznany argument to błąd, nie ciche zignorowanie', () => {
    expect(() => parseArgs(['verify', '--outt', 'x'])).toThrow(/Nieznany argument/)
  })

  it('brakująca wartość opcji to błąd', () => {
    expect(() => parseArgs(['verify', '--in'])).toThrow(/Brakuje wartości/)
  })
})

describe('resolveKey', () => {
  it('bierze klucz ze zmiennej środowiskowej', () => {
    expect(resolveKey(parseArgs(['verify']), { LUNOR_BACKUP_KEY: KEY })).toBe(KEY)
  })

  it('bierze klucz z pliku i obcina biały znak z końca', () => {
    // Plik z kluczem prawie zawsze kończy się znakiem nowej linii.
    const p = join(dir, 'klucz.txt')
    writeFileSync(p, `${KEY}\n`)
    expect(resolveKey(parseArgs(['verify', '--key-file', p]), {})).toBe(KEY)
  })

  it('plik ma pierwszeństwo przed zmienną', () => {
    const p = join(dir, 'klucz.txt')
    writeFileSync(p, KEY)
    expect(resolveKey(parseArgs(['verify', '--key-file', p]), { LUNOR_BACKUP_KEY: OTHER_KEY })).toBe(KEY)
  })

  it('brak klucza mówi WPROST, czego brakuje', () => {
    expect(() => resolveKey(parseArgs(['verify']), {})).toThrow(/LUNOR_BACKUP_KEY/)
  })
})

describe('main — kody wyjścia', () => {
  it('verify poprawnego artefaktu zwraca 0', async () => {
    const { path, checksum } = await writeArtifact(randomBytes(20_000))
    expect(await main(['verify', '--in', path, '--checksum', checksum], { LUNOR_BACKUP_KEY: KEY })).toBe(0)
  })

  it('restore zapisuje zrzut bajt w bajt', async () => {
    const plaintext = Buffer.from('CREATE TABLE t (id int);\nINSERT INTO t VALUES (1);\n')
    const { path } = await writeArtifact(plaintext)
    const out = join(dir, 'odtworzony.sql')
    expect(await main(['restore', '--in', path, '--out', out], { LUNOR_BACKUP_KEY: KEY })).toBe(0)
    expect(readFileSync(out).equals(plaintext)).toBe(true)
  })

  it('zły klucz zwraca 1 (awaria), nie 2 (błąd użycia)', async () => {
    // Rozróżnienie ma znaczenie w skrypcie: 2 = źle wywołałeś,
    // 1 = wywołałeś dobrze, ale kopia jest nie do odczytania.
    const { path } = await writeArtifact(randomBytes(4096))
    expect(await main(['verify', '--in', path], { LUNOR_BACKUP_KEY: OTHER_KEY })).toBe(1)
  })

  it('brak --in zwraca 2', async () => {
    expect(await main(['verify'], { LUNOR_BACKUP_KEY: KEY })).toBe(2)
  })

  it('brak klucza zwraca 2', async () => {
    const { path } = await writeArtifact(randomBytes(1024))
    expect(await main(['verify', '--in', path], {})).toBe(2)
  })

  it('restore bez --out i bez --to-database zwraca 2', async () => {
    const { path } = await writeArtifact(randomBytes(1024))
    expect(await main(['restore', '--in', path], { LUNOR_BACKUP_KEY: KEY })).toBe(2)
  })

  it('--to-database bez DATABASE_URL zwraca 2 zamiast startować odszyfrowywanie', async () => {
    // Błąd konfiguracji musi wyjść ZANIM zaczniemy deszyfrować stugigowy plik.
    const { path } = await writeArtifact(randomBytes(1024))
    expect(await main(['restore', '--in', path, '--to-database'], { LUNOR_BACKUP_KEY: KEY })).toBe(2)
  })

  it('nieznane polecenie zwraca 2', async () => {
    expect(await main(['zrób-magię', '--in', 'x'], { LUNOR_BACKUP_KEY: KEY })).toBe(2)
  })

  it('help zwraca 0, samo wywołanie bez argumentów zwraca 2', async () => {
    expect(await main(['help'], {})).toBe(0)
    expect(await main([], {})).toBe(2)
  })

  it('rozjazd sumy kontrolnej zwraca 1', async () => {
    const { path } = await writeArtifact(randomBytes(4096))
    expect(
      await main(['verify', '--in', path, '--checksum', 'f'.repeat(64)], { LUNOR_BACKUP_KEY: KEY }),
    ).toBe(1)
  })

  it('nieistniejący plik zwraca 1, a nie wywala się śladem stosu', async () => {
    expect(await main(['verify', '--in', join(dir, 'nie-ma.enc')], { LUNOR_BACKUP_KEY: KEY })).toBe(1)
  })

  it('klucz nie wycieka do żadnego komunikatu', async () => {
    const { path } = await writeArtifact(randomBytes(4096))
    const spy = vi.mocked(console.error)
    await main(['verify', '--in', path], { LUNOR_BACKUP_KEY: OTHER_KEY })
    const wypisane = spy.mock.calls.flat().join('\n')
    expect(wypisane).not.toContain(OTHER_KEY)
  })
})
