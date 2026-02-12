import { NextRequest, NextResponse } from "next/server";
import { getLogVault } from "@/lib/LogVault";
import { withLogVault } from "@/lib/LogVault-helpers";

// ---- GET /api/users ----
export const GET = withLogVault(
  async (req: NextRequest) => {
    const LogVault = getLogVault();

    const users = await LogVault.performance.measure(
      "db.users.list",
      async () => {
        // Simulated prisma call
        await new Promise((r) => setTimeout(r, 100));
        return [
          { id: "1", name: "Alice", email: "alice@example.com" },
          { id: "2", name: "Bob", email: "bob@example.com" },
        ];
      },
      { table: "users" },
    );

    LogVault.info("Users fetched", { count: users.length });

    return NextResponse.json({ users });
  },
  { name: "GET /api/users" },
);

// ---- POST /api/users ----
export const POST = withLogVault(
  async (req: NextRequest) => {
    const LogVault = getLogVault();
    const body = await req.json();

    const { name, email, password } = body;

    if (!name || !email) {
      LogVault.warn("User creation validation failed", {
        providedFields: Object.keys(body),
      });
      return NextResponse.json(
        { error: "Name and email required" },
        { status: 400 },
      );
    }

    const user = await LogVault.withScope(
      { tags: ["user-creation"], extra: { operation: "CREATE" } },
      async () => {
        LogVault.info("Creating user", {
          name,
          email,
          password, // Auto-redacted by sanitizer
        });

        // Simulate insert
        await new Promise((r) => setTimeout(r, 50));

        return { id: crypto.randomUUID(), name, email };
      },
    );

    LogVault.info("User created", { userId: user.id });

    return NextResponse.json({ user }, { status: 201 });
  },
  { name: "POST /api/users" },
);
