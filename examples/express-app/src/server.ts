import express from "express";
import helmet from "helmet";
import LogVault from "./LogVault";
import { requestLogger, errorHandler } from "./middleware/logging";
import { securityMonitor } from "./middleware/security";
import usersRouter from "./routes/users";

const app = express();
const PORT = process.env.PORT || 3001;

// ============================================================
// Middleware — Order matters!
// ============================================================

// Security headers
app.use(helmet());

// Body parsing
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// LogVault request logging (must be early)
app.use(requestLogger());

// LogVault security monitoring
app.use(securityMonitor());

// ============================================================
// Routes
// ============================================================

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/users", usersRouter);

// ============================================================
// 404 handler
// ============================================================

app.use((req, res) => {
  LogVault.warn(`Route not found: ${req.method} ${req.path}`, {
    method: req.method,
    path: req.path,
    ip: req.ip,
  });

  res.status(404).json({ error: "Route not found" });
});

// ============================================================
// Global error handler (must be last)
// ============================================================

app.use(errorHandler());

// ============================================================
// Server startup
// ============================================================

const server = app.listen(PORT, () => {
  LogVault.info(`Server started on port ${PORT}`, {
    port: PORT,
    environment: process.env.NODE_ENV,
    nodeVersion: process.version,
    pid: process.pid,
  });

  console.log(`🚀 Server running at http://localhost:${PORT}`);
});

// ============================================================
// Graceful shutdown
// ============================================================

async function gracefulShutdown(signal: string) {
  LogVault.info(`Received ${signal} — starting graceful shutdown`, {
    signal,
    uptime: process.uptime(),
  });

  // Flush all pending LogVault events
  await LogVault.flush();

  server.close(async () => {
    LogVault.info("Server closed — all connections drained");
    await LogVault.destroy();
    process.exit(0);
  });

  // Force kill after 10s
  setTimeout(() => {
    LogVault.fatal("Forced shutdown — timeout exceeded");
    LogVault.flush().finally(() => process.exit(1));
  }, 10000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

export default app;
