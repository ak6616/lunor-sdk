import { Router, Request, Response, NextFunction } from "express";
import LogVault from "../LogVault";
import { bruteForceDetector } from "../middleware/security";

const router = Router();
const bruteForce = bruteForceDetector({
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000,
});

// Simulated DB
const users = [
  { id: "1", name: "Alice", email: "alice@example.com" },
  { id: "2", name: "Bob", email: "bob@example.com" },
];

// ---- GET /users ----
router.get("/", async (_req: Request, res: Response) => {
  // Use performance monitoring
  const result = await LogVault.performance.measure(
    "db.users.findAll",
    async () => {
      // Simulate DB query
      await new Promise((resolve) => setTimeout(resolve, 50));
      return users;
    },
    { table: "users", operation: "SELECT" },
  );

  LogVault.info("Fetched all users", { count: result.length });

  res.json({ users: result });
});

// ---- GET /users/:id ----
router.get("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;

  const user = users.find((u) => u.id === id);

  if (!user) {
    LogVault.warn(`User not found: ${id}`, { requestedId: id });
    return res.status(404).json({ error: "User not found" });
  }

  LogVault.info(`Fetched user: ${user.name}`, { userId: id });
  res.json({ user });
});

// ---- POST /users ----
router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email) {
      LogVault.warn("User creation failed — missing fields", {
        providedFields: Object.keys(req.body),
      });
      return res.status(400).json({ error: "Name and email are required" });
    }

    // Simulate creation with scoped context
    const newUser = await LogVault.withScope(
      {
        tags: ["user-creation"],
        extra: { operation: "CREATE_USER" },
      },
      async () => {
        // Log the attempt (password will be auto-redacted by sanitizer!)
        LogVault.info("Creating new user", {
          name,
          email,
          password, // ← will become [REDACTED]
        });

        const user = {
          id: String(users.length + 1),
          name,
          email,
        };

        users.push(user);

        LogVault.info("User created successfully", { userId: user.id });
        return user;
      },
    );

    res.status(201).json({ user: newUser });
  } catch (error) {
    next(error);
  }
});

// ---- POST /login ----
router.post("/login", async (req: Request, res: Response) => {
  const { email, password } = req.body;
  const ip = req.ip || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  // Simulate authentication
  const user = users.find((u) => u.email === email);

  if (!user || password !== "correctpassword") {
    // Track failed attempt
    bruteForce.recordFailedAttempt(ip, userAgent, "/users/login");

    LogVault.warn("Failed login attempt", {
      email,
      ip,
      reason: !user ? "user_not_found" : "invalid_password",
    });

    // Report auth failure as security event
    LogVault.security({
      type: "AUTH_FAILURE",
      description: `Failed login attempt for ${email}`,
      ipAddress: ip,
      userAgent,
      metadata: { email },
    });

    return res.status(401).json({ error: "Invalid credentials" });
  }

  // Successful login
  bruteForce.recordSuccessfulAttempt(ip);

  LogVault.setUser(user.id, { email: user.email, name: user.name });

  LogVault.info("User logged in successfully", {
    userId: user.id,
    email: user.email,
    ip,
  });

  res.json({
    token: "fake-jwt-token-" + user.id,
    user: { id: user.id, name: user.name, email: user.email },
  });
});

// ---- DELETE /users/:id ----
router.delete(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const index = users.findIndex((u) => u.id === id);

      if (index === -1) {
        LogVault.warn(`Delete failed — user not found: ${id}`);
        return res.status(404).json({ error: "User not found" });
      }

      const deleted = users.splice(index, 1)[0];

      LogVault.info(`User deleted: ${deleted.name}`, {
        userId: id,
        deletedBy: (req as Record<string, unknown>).userId || "anonymous",
      });

      res.json({ success: true, deleted });
    } catch (error) {
      next(error);
    }
  },
);

// ---- GET /users/crash (test error handling) ----
router.get("/crash", async (_req: Request, _res: Response) => {
  // This will be caught by the global error handler
  throw new Error("Intentional crash for testing error capture");
});

// ---- GET /users/slow (test performance monitoring) ----
router.get("/slow", async (_req: Request, res: Response) => {
  const result = await LogVault.performance.measure(
    "slow_operation",
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return { computed: true };
    },
    { description: "Simulated slow DB query" },
  );

  res.json({ result });
});

export default router;
