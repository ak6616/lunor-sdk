// src/hmac.ts
//
// HMAC v1 request signing for Lunor backend.
//
// Specification (must match /home/ak6616/lunor server):
//   - Header: X-Lunor-Signature: v1=<hex>
//   - Header: X-Lunor-Timestamp: <unix-seconds>
//   - Header: X-API-Key: <public key>   (apiSecret is NEVER sent)
//   - Signed string: `${timestamp}.${rawBody}`
//       where rawBody is the EXACT JSON string sent as the request body.
//   - Algorithm: HMAC-SHA256, key = apiSecret (UTF-8)
//   - Replay window: 5 minutes (enforced server-side)
//
// The implementation is environment-aware:
//   - Browser / Edge / Workers: WebCrypto (`crypto.subtle`)
//   - Node.js (SSR / server tests): `node:crypto.createHmac`

const HEADER_SIGNATURE = "X-Lunor-Signature";
const HEADER_TIMESTAMP = "X-Lunor-Timestamp";

export interface SignedHeaders {
  [HEADER_SIGNATURE]: string;
  [HEADER_TIMESTAMP]: string;
}

/**
 * Compute current unix timestamp in seconds as a string.
 */
export function nowUnixSeconds(): string {
  return Math.floor(Date.now() / 1000).toString();
}

function hexFromBuffer(buf: ArrayBuffer | Uint8Array): string {
  const bytes =
    buf instanceof Uint8Array ? buf : new Uint8Array(buf as ArrayBuffer);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const h = bytes[i].toString(16);
    out += h.length === 1 ? "0" + h : h;
  }
  return out;
}

/**
 * Compute HMAC-SHA256(secret, message) and return hex string.
 * Uses WebCrypto when available, falls back to node:crypto on Node.js.
 */
export async function hmacSha256Hex(
  secret: string,
  message: string,
): Promise<string> {
  // WebCrypto path — browsers, modern Node (>=20 has globalThis.crypto.subtle),
  // Edge runtimes, Cloudflare Workers.
  const subtle: SubtleCrypto | undefined =
    typeof globalThis !== "undefined"
      ? (globalThis as unknown as { crypto?: Crypto }).crypto?.subtle
      : undefined;

  if (subtle) {
    const enc = new TextEncoder();
    const key = await subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await subtle.sign("HMAC", key, enc.encode(message));
    return hexFromBuffer(sig);
  }

  // Fallback: Node.js built-in crypto. Loaded dynamically so bundlers building
  // for the browser do not statically include it.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodeCrypto = await import("node:crypto");
    return nodeCrypto.createHmac("sha256", secret).update(message).digest("hex");
  } catch (err) {
    throw new Error(
      "[Lunor] No crypto implementation available for HMAC signing: " +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

/**
 * Build the set of authentication headers for a given raw request body.
 *
 * The signature covers `${timestamp}.${rawBody}`. `rawBody` MUST be the exact
 * string that will be written to the network — do NOT re-stringify downstream.
 */
export async function signRequest(
  apiSecret: string,
  rawBody: string,
  timestamp: string = nowUnixSeconds(),
): Promise<SignedHeaders> {
  const signature = await hmacSha256Hex(apiSecret, `${timestamp}.${rawBody}`);
  return {
    [HEADER_SIGNATURE]: `v1=${signature}`,
    [HEADER_TIMESTAMP]: timestamp,
  };
}
