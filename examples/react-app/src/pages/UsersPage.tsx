import React, { useState, useEffect } from "react";
import { useLogVault } from "../hooks/useLogVault";
import { LogVaultErrorBoundary } from "../components/ErrorBoundary";
import { api } from "../lib/api";

interface User {
  id: string;
  name: string;
  email: string;
}

function UsersPageContent() {
  const { trackEvent, trackError, trackAction } = useLogVault("UsersPage");
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  // Fetch users on mount
  useEffect(() => {
    async function loadUsers() {
      try {
        const { data } = await api<{ users: User[] }>("/users");
        setUsers(data.users);
        trackEvent("Users loaded", { count: data.users.length });
      } catch (error) {
        trackError(
          error instanceof Error ? error : new Error("Failed to load users"),
          "HIGH",
        );
      } finally {
        setLoading(false);
      }
    }

    loadUsers();
  }, [trackEvent, trackError]);

  // Create user
  async function handleCreateUser(e: React.FormEvent) {
    e.preventDefault();
    trackAction("create_user_submit", { name, email });

    try {
      const { data } = await api<{ user: User }>("/users", {
        method: "POST",
        body: { name, email },
      });

      setUsers((prev) => [...prev, data.user]);
      setName("");
      setEmail("");

      trackEvent("User created", { userId: data.user.id });
    } catch (error) {
      trackError(
        error instanceof Error ? error : new Error("Failed to create user"),
        "MEDIUM",
        {
          formData: { name, email },
        },
      );
    }
  }

  // Delete user
  async function handleDeleteUser(userId: string) {
    trackAction("delete_user_click", { userId });

    try {
      await api(`/users/${userId}`, { method: "DELETE" });
      setUsers((prev) => prev.filter((u) => u.id !== userId));
      trackEvent("User deleted", { userId });
    } catch (error) {
      trackError(
        error instanceof Error ? error : new Error("Failed to delete user"),
        "MEDIUM",
        {
          userId,
        },
      );
    }
  }

  if (loading) return <div>Loading...</div>;

  return (
    <div>
      <h1>Users</h1>

      {/* Create User Form */}
      <form onSubmit={handleCreateUser}>
        <input
          type="text"
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <button type="submit">Create User</button>
      </form>

      {/* Users List */}
      <ul>
        {users.map((user) => (
          <li key={user.id}>
            {user.name} ({user.email})
            <button onClick={() => handleDeleteUser(user.id)}>Delete</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Wrap with Error Boundary
export default function UsersPage() {
  return (
    <LogVaultErrorBoundary componentName="UsersPage">
      <UsersPageContent />
    </LogVaultErrorBoundary>
  );
}
