// src/scrubber.ts
//
// Scrub sensitive data (PII, secrets, tokens) from values before they are
// persisted or sent to the Lunor backend. Used by:
//   - captureConsole (global-handlers.ts)
//   - captureError / captureException (client.ts)
//   - setUser (client.ts)
//   - PersistentQueue (queue.ts) — only sanitized data is persisted
//   - Transport (transport.ts) — final defensive pass before network send
//
// The scrubber never throws: all inputs are best-effort cleaned and returned.
// For deeply nested / huge structures there are hard caps on depth and array
// length to keep execution bounded.

const MAX_DEPTH = 5;
const MAX_ARRAY_ITEMS = 100;
const MAX_STRING_LENGTH = 8 * 1024; // 8KB per string

// Keys whose values should be fully redacted (case-insensitive match anywhere
// in the key). These are common secret / credential holders.
const DENYLIST_KEYS: RegExp[] = [
  /password/i,
  /passwd/i,
  /\bpwd\b/i,
  /secret/i,
  /token/i,
  /\bauth(?:orization)?\b/i,
  /\bapi[_-]?key\b/i,
  /\bapi[_-]?secret\b/i,
  /apikey/i,
  /apisecret/i,
  /\bjwt\b/i,
  /\bcookie\b/i,
  /set-cookie/i,
  /session/i,
  /x-api-key/i,
  /x-api-secret/i,
  /x-lunor-signature/i,
];

// Keys whose values should be lightly masked (not fully removed) — e.g. email.
const MASK_KEYS: RegExp[] = [/email/i];

const REDACTED = "[REDACTED]";
const REDACTED_CARD = "[REDACTED_CARD]";
const REDACTED_JWT = "[REDACTED_JWT]";
const REDACTED_BEARER = "[REDACTED_BEARER]";

// ---- String-level patterns -------------------------------------------------

const BEARER_RE = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi;

// kv patterns: key="value" / key: value / key=value. We match the key too so
// we can redact the value but preserve the key for debugging.
const KV_SECRET_RE =
  /(api[_-]?key|apikey|api[_-]?secret|apisecret|secret|password|passwd|pwd|token|auth(?:orization)?|jwt)(["'\s:=]+)([^"'\s,}\]]+)/gi;

const EMAIL_RE = /([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

// JWT: three base64url segments separated by dots, first must start with "eyJ".
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

// Candidate card number (13-19 digits). We post-filter with Luhn below.
const CARD_CANDIDATE_RE = /\b\d{13,19}\b/g;

/**
 * Luhn checksum — used to reduce false positives when redacting card-like
 * number sequences.
 */
function luhnValid(num: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let n = num.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * Scrub a string: apply all token / secret / PII regex replacements.
 */
export function scrubString(input: string): string {
  if (typeof input !== "string") return input;

  let out = input;

  // Truncate runaway strings first so later regexes are bounded.
  if (out.length > MAX_STRING_LENGTH) {
    out =
      out.slice(0, MAX_STRING_LENGTH) +
      `... [truncated ${out.length - MAX_STRING_LENGTH} chars]`;
  }

  // Order matters: JWT before bearer (bearer can contain JWT), both before kv.
  out = out.replace(JWT_RE, REDACTED_JWT);
  out = out.replace(BEARER_RE, REDACTED_BEARER);
  out = out.replace(KV_SECRET_RE, (_m, key, sep) => `${key}${sep}${REDACTED}`);
  out = out.replace(EMAIL_RE, (_m, _local, domain) => `*@${domain}`);
  out = out.replace(CARD_CANDIDATE_RE, (m) =>
    luhnValid(m) ? REDACTED_CARD : m,
  );

  return out;
}

/**
 * Mask an email address: `alice@example.com` → `*@example.com`.
 * Returns the input unchanged if it is not a plausible email.
 */
export function maskEmail(input: string): string {
  if (typeof input !== "string") return input;
  const m = input.match(/^([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})$/);
  if (!m) return scrubString(input);
  return `*@${m[2]}`;
}

function keyInDenylist(key: string): boolean {
  for (const re of DENYLIST_KEYS) {
    if (re.test(key)) return true;
  }
  return false;
}

function keyInMaskList(key: string): boolean {
  for (const re of MASK_KEYS) {
    if (re.test(key)) return true;
  }
  return false;
}

/**
 * Recursively scrub a value. Primitive strings get regex redaction, objects
 * get key-based redaction, arrays are capped at MAX_ARRAY_ITEMS, and recursion
 * is capped at MAX_DEPTH.
 */
export function scrubSensitive(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;

  if (depth >= MAX_DEPTH) {
    if (typeof value === "object") return "[MaxDepth]";
    if (typeof value === "string") return scrubString(value);
    return value;
  }

  if (typeof value === "string") return scrubString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();

  if (Array.isArray(value)) {
    const limited = value.slice(0, MAX_ARRAY_ITEMS);
    const out = limited.map((v) => scrubSensitive(v, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      out.push(`[+${value.length - MAX_ARRAY_ITEMS} more]`);
    }
    return out;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message),
      stack: value.stack ? scrubString(value.stack) : undefined,
    };
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (keyInDenylist(key)) {
        out[key] = REDACTED;
        continue;
      }
      if (keyInMaskList(key) && typeof val === "string") {
        out[key] = maskEmail(val);
        continue;
      }
      out[key] = scrubSensitive(val, depth + 1);
    }
    return out;
  }

  // Functions, symbols, etc. — drop.
  return undefined;
}

/**
 * Convenience: scrub a plain object and return it typed as Record.
 */
export function scrubObject(
  obj: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!obj) return obj;
  return scrubSensitive(obj) as Record<string, unknown>;
}
