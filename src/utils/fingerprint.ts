/**
 * Generates a deterministic fingerprint for error grouping.
 */
export function generateErrorFingerprint(
  message: string,
  stack?: string | null,
  type?: string,
): string {
  const parts: string[] = [];

  if (type) parts.push(type);

  // Clean up message — remove variable parts
  const cleanMessage = message
    .replace(/\b\d+\b/g, "<N>") // numbers
    .replace(/['"][^'"]*['"]/g, "<S>") // strings
    .replace(/0x[0-9a-fA-F]+/g, "<HEX>") // hex addresses
    .trim();

  parts.push(cleanMessage);

  // Extract first meaningful stack frame
  if (stack) {
    const lines = stack.split("\n");
    const firstFrame = lines.find(
      (line) =>
        line.includes("at ") &&
        !line.includes("node_modules") &&
        !line.includes("<anonymous>"),
    );

    if (firstFrame) {
      // Extract file and line info
      const match = firstFrame.match(/at\s+(.+?)\s+\((.+?):(\d+):\d+\)/);
      if (match) {
        parts.push(`${match[1]}@${match[2]}:${match[3]}`);
      }
    }
  }

  return simpleHash(parts.join("|"));
}

function simpleHash(str: string): string {
  let hash = 0;

  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }

  return Math.abs(hash).toString(36);
}
