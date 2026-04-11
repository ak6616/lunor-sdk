// src/validation.ts
//
// Inbound payload validation + size enforcement. Oversized payloads are
// rejected early so we never ship more than a bounded amount of data to the
// backend (which limits abuse surface and mitigates log-bombing attacks).

import type { WebhookPayload, LogPayload, ErrorPayload } from "./types";
import type { createInternalLogger } from "./utils";

export const MAX_MESSAGE_BYTES = 2 * 1024; // 2KB
export const MAX_METADATA_BYTES = 8 * 1024; // 8KB
export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 64;
export const MAX_PAYLOAD_BYTES_FETCH = 256 * 1024; // 256KB
export const MAX_PAYLOAD_BYTES_BEACON = 64 * 1024; // 64KB

type Logger = ReturnType<typeof createInternalLogger>;

/**
 * Measure the byte length of a string using UTF-8 encoding when available,
 * otherwise fall back to a char-count approximation.
 */
export function byteLength(str: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(str).length;
  }
  return str.length;
}

function jsonSize(value: unknown): number {
  try {
    return byteLength(JSON.stringify(value) ?? "");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Validate an event payload. Returns the (possibly trimmed) payload, or null
 * when the payload must be rejected. Logs a warning to the internal logger
 * when trimming or rejecting.
 */
export function validateEventPayload(
  event: WebhookPayload,
  logger: Logger,
): WebhookPayload | null {
  if (!event || typeof event !== "object") {
    logger.warn("validation: event is not an object — rejected");
    return null;
  }

  const data = (event.data ?? {}) as LogPayload & ErrorPayload;

  // --- message ------------------------------------------------------------
  if ("message" in data && typeof data.message === "string") {
    const size = byteLength(data.message);
    if (size > MAX_MESSAGE_BYTES) {
      logger.warn(
        `validation: message is ${size}B > ${MAX_MESSAGE_BYTES}B — truncated`,
      );
      data.message =
        data.message.slice(0, MAX_MESSAGE_BYTES) + "... [truncated]";
    }
  }

  // --- metadata -----------------------------------------------------------
  if ("metadata" in data && data.metadata && typeof data.metadata === "object") {
    const size = jsonSize(data.metadata);
    if (size > MAX_METADATA_BYTES) {
      logger.warn(
        `validation: metadata is ${size}B > ${MAX_METADATA_BYTES}B — dropped`,
      );
      data.metadata = { __lunor_dropped: "metadata exceeded size limit" };
    }
  }

  // --- tags ---------------------------------------------------------------
  const tags = event._meta?.context?.tags;
  if (tags && typeof tags === "object") {
    const entries = Object.entries(tags);
    if (entries.length > MAX_TAGS) {
      logger.warn(
        `validation: tags count ${entries.length} > ${MAX_TAGS} — trimming`,
      );
      const trimmed: Record<string, string> = {};
      for (const [k, v] of entries.slice(0, MAX_TAGS)) {
        trimmed[k.slice(0, MAX_TAG_LENGTH)] =
          typeof v === "string" ? v.slice(0, MAX_TAG_LENGTH) : String(v).slice(0, MAX_TAG_LENGTH);
      }
      if (event._meta?.context) event._meta.context.tags = trimmed;
    } else {
      for (const [k, v] of entries) {
        if (k.length > MAX_TAG_LENGTH || String(v).length > MAX_TAG_LENGTH) {
          tags[k.slice(0, MAX_TAG_LENGTH)] = String(v).slice(0, MAX_TAG_LENGTH);
        }
      }
    }
  }

  return event;
}

/**
 * Enforce a hard total-size ceiling on a serialized payload before shipping.
 * Returns null when the payload should not be sent.
 */
export function enforceTransportSize(
  rawBody: string,
  mode: "fetch" | "beacon",
  logger: Logger,
): string | null {
  const limit =
    mode === "beacon" ? MAX_PAYLOAD_BYTES_BEACON : MAX_PAYLOAD_BYTES_FETCH;
  const size = byteLength(rawBody);
  if (size > limit) {
    logger.warn(
      `transport: payload is ${size}B > ${limit}B (${mode}) — dropped`,
    );
    return null;
  }
  return rawBody;
}
