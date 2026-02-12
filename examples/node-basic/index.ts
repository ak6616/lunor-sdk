import { LogVaultClient } from "@LogVault/sdk";

async function main() {
  // Create client
  const LogVault = new LogVaultClient({
    apiKey: "your-api-key",
    apiSecret: "your-api-secret",
    endpoint: "https://your-app.com/api/webhook",
    environment: "production",
    release: "2.1.0",
    defaultSource: "cron-job",
    captureGlobalErrors: true,
    debug: true,
  });

  // ---- Basic Logging ----
  await LogVault.info("Cron job started");
  await LogVault.trace("Connecting to database...");

  // ---- With Metadata ----
  await LogVault.info("Processing batch", {
    batchId: "batch-001",
    itemCount: 150,
    estimatedTime: "30s",
  });

  // ---- Error Capturing ----
  try {
    // Simulate work
    await riskyOperation();
  } catch (error) {
    await LogVault.captureException(error as Error, {
      severity: "HIGH",
      metadata: { step: "data-processing", batchId: "batch-001" },
    });
  }

  // ---- Performance Tracking ----
  const result = await LogVault.performance.measure(
    "external_api_call",
    async () => {
      await new Promise((r) => setTimeout(r, 500));
      return { records: 42 };
    },
    { api: "payments", endpoint: "/transactions" },
  );

  console.log("Result:", result);

  // ---- Scoped Context ----
  await LogVault.withScope(
    {
      userId: "user-123",
      requestId: "req-abc",
      tags: ["batch-processing", "high-priority"],
    },
    async () => {
      await LogVault.info("Processing user data");
      await LogVault.info("User data processed successfully");
    },
  );

  // ---- Security Event ----
  await LogVault.security({
    type: "UNAUTHORIZED_ACCESS",
    description: "Attempted access to admin endpoint without credentials",
    ipAddress: "192.168.1.100",
    metadata: { path: "/admin/users", method: "DELETE" },
  });

  // ---- Wrap Async Functions ----
  const safeOperation = LogVault.wrapAsync(
    async (data: unknown) => {
      // If this throws, it's automatically captured
      throw new Error("Something broke!");
    },
    { severity: "CRITICAL", metadata: { context: "wrapped-function" } },
  );

  try {
    await safeOperation({ test: true });
  } catch {
    // Error was already sent to LogVault
  }

  // ---- Cleanup ----
  await LogVault.flush();
  await LogVault.destroy();

  console.log("✅ All events sent!");
}

async function riskyOperation() {
  throw new TypeError('Cannot read properties of undefined (reading "name")');
}

main().catch(console.error);
