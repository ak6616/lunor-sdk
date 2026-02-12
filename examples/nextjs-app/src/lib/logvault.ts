import { LogVaultClient } from "@LogVault/sdk";

// Server-side singleton (Edge/Node runtime)
let client: LogVaultClient | null = null;

export function getLogVault(): LogVaultClient {
  if (!client) {
    client = new LogVaultClient({
      apiKey: process.env.LogVault_API_KEY!,
      apiSecret: process.env.LogVault_API_SECRET!,
      endpoint: process.env.LogVault_ENDPOINT!,
      environment: process.env.NODE_ENV,
      release: process.env.NEXT_PUBLIC_APP_VERSION || "1.0.0",
      defaultSource: "nextjs-api",

      captureGlobalErrors: true,
      enableBatching: true,
      batchInterval: 3000,
      batchSize: 20,
      sanitize: true,

      minLevel: process.env.NODE_ENV === "production" ? "INFO" : "DEBUG",

      globalMetadata: {
        framework: "nextjs",
        runtime: typeof EdgeRuntime !== "undefined" ? "edge" : "node",
      },
    });
  }
  return client;
}
