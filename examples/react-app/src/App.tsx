import React, { useEffect } from "react";
import LogVault from "./lib/LogVault";
import { LogVaultErrorBoundary } from "./components/ErrorBoundary";
import UsersPage from "./pages/UsersPage";

export default function App() {
  useEffect(() => {
    // Set user context after auth
    LogVault.setUser("current-user-id", {
      email: "user@example.com",
      plan: "pro",
    });

    LogVault.info("App initialized");

    // Flush on page unload
    const handleUnload = () => {
      LogVault.flush();
    };

    window.addEventListener("beforeunload", handleUnload);

    return () => {
      window.removeEventListener("beforeunload", handleUnload);
    };
  }, []);

  return (
    <LogVaultErrorBoundary componentName="App">
      <UsersPage />
    </LogVaultErrorBoundary>
  );
}
