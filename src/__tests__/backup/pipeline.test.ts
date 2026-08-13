import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import { createDecipheriv, createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import {
  buildArtifactStream,
  keyFingerprint,
  parseEncryptionKey,
  BackupSizeExceededError,
  InvalidEncryptionKeyError,
  MAGIC,
} from '../../backup/pipeline'

const KEY = 'a'.repeat(64)
const OTHER_KEY = 'b'.repeat(64)

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(c))
  return Buffer.concat(chunks)
}

/** Odtwarza artefakt — dokładnie to, co musi zrobić operator przy restore. */
function decryptArtifact(artifact: Buffer, keyHex: string): Buffer {
  expect(artifact.subarray(0, 8).equals(MAGIC)).toBe(true)
  const iv = artifact.subarray(8, 20)
  const tag = artifact.subarray(artifact.length - 16)
  const ciphertext = artifact.subarray(20, artifact.length - 16)

  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv)
  decipher.setAuthTag(tag)
  const gz = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return gunzipSync(gz)
}

describe('parseEncryptionKey', () => {
  it('przyjmuje 64-znakowy hex', () => {
    expect(parseEncryptionKey(KEY).length).toBe(32)
  })

  it.each(['', 'zz', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64)])(
    'odrzuca niepoprawny klucz: %j',
    (bad) => {
      expect(() => parseEncryptionKey(bad)).toThrow(InvalidEncryptionKeyError)
    },
  )
})

describe('keyFingerprint', () => {
  it('jest stabilny dla tego samego klucza', () => {
    expect(keyFingerprint(KEY)).toBe(keyFingerprint(KEY))
  })

  it('różni się dla różnych kluczy', () => {
    expect(keyFingerprint(KEY)).not.toBe(keyFingerprint(OTHER_KEY))
  })

  it('NIE zawiera samego klucza', () => {
    expect(keyFingerprint(KEY)).not.toContain(KEY.slice(0, 16))
  })
})

describe('buildArtifactStream — round-trip', () => {
  it('artefakt daje się odszyfrować i rozpakować tym samym kluczem', async () => {
    const payload = Buffer.from('-- dump SQL --\n'.repeat(500))
    const { stream, result } = buildArtifactStream(Readable.from([payload]), KEY, 10 * 1024 * 1024)

    const artifact = await collect(stream)
    await result

    expect(decryptArtifact(artifact, KEY).equals(payload)).toBe(true)
  })

  it('zaczyna się magią i zawiera IV oraz authTag (bez nich restore niemożliwy)', async () => {
    const { stream, result } = buildArtifactStream(
      Readable.from([Buffer.from('x')]),
      KEY,
      1024 * 1024,
    )
    const artifact = await collect(stream)
    await result

    expect(artifact.subarray(0, 8).equals(MAGIC)).toBe(true)
    // magia(8) + IV(12) + authTag(16) = 36 B narzutu minimum
    expect(artifact.length).toBeGreaterThanOrEqual(36)
  })

  it('zły klucz NIE odszyfrowuje (GCM wykrywa podmianę)', async () => {
    const { stream, result } = buildArtifactStream(
      Readable.from([Buffer.from('poufne dane')]),
      KEY,
      1024 * 1024,
    )
    const artifact = await collect(stream)
    await result

    expect(() => decryptArtifact(artifact, OTHER_KEY)).toThrow()
  })

  it('checksum liczony jest na GOTOWYM artefakcie (tym, co idzie do storage)', async () => {
    const { stream, result } = buildArtifactStream(
      Readable.from([Buffer.from('abc'.repeat(100))]),
      KEY,
      1024 * 1024,
    )
    const artifact = await collect(stream)
    const { checksum, sizeBytes } = await result

    expect(checksum).toBe(createHash('sha256').update(artifact).digest('hex'))
    expect(sizeBytes).toBe(artifact.length)
  })

  it('kompresja działa — powtarzalne dane dają artefakt mniejszy od wejścia', async () => {
    const payload = Buffer.from('A'.repeat(200_000))
    const { stream, result } = buildArtifactStream(
      Readable.from([payload]),
      KEY,
      10 * 1024 * 1024,
    )
    await collect(stream)
    const { sizeBytes } = await result

    expect(sizeBytes).toBeLessThan(payload.length / 10)
  })
})

describe('buildArtifactStream — limit rozmiaru', () => {
  it('przekroczenie limitu PRZERYWA zamiast wysłać obcięty plik', async () => {
    // Losowe (nieściśliwe) dane, żeby gzip nie zmieścił ich pod limitem.
    const noise = Buffer.alloc(300_000)
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 7919) % 256

    const { stream, result } = buildArtifactStream(Readable.from([noise]), KEY, 1024)

    await expect(
      (async () => {
        await collect(stream)
        await result
      })(),
    ).rejects.toBeInstanceOf(BackupSizeExceededError)
  })
})

describe('buildArtifactStream — błąd źródła', () => {
  it('błąd strumienia zrzutu propaguje się jako odrzucenie', async () => {
    const broken = new Readable({
      read() {
        this.destroy(new Error('pg_dump padł'))
      },
    })
    const { stream, result } = buildArtifactStream(broken, KEY, 1024 * 1024)

    await expect(
      (async () => {
        await collect(stream)
        await result
      })(),
    ).rejects.toThrow()
  })
})
