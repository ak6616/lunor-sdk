import React, { Component, ErrorInfo, ReactNode } from "react";
import LogVault from "../lib/LogVault";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  componentName?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class LogVaultErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    LogVault.captureException(error, {
      severity: "HIGH",
      type: "RUNTIME",
      metadata: {
        componentStack: info.componentStack,
        component: this.props.componentName || "unknown",
        boundary: "ErrorBoundary",
      },
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback || (
          <div style={{ padding: "2rem", textAlign: "center" }}>
            <h2>Something went wrong</h2>
            <p>{this.state.error?.message}</p>
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null });
                LogVault.info("User dismissed error boundary", {
                  component: this.props.componentName,
                });
              }}
            >
              Try again
            </button>
          </div>
        )
      );
    }

    return this.props.children;
  }
}
