import { useEffect, useCallback, useRef } from "react";
import LogVault from "../lib/LogVault";
import type { Metadata, Severity } from "@LogVault/sdk";

/**
 * Hook: Automatic component lifecycle logging + error capture utilities
 */
export function useLogVault(componentName: string) {
  const renderCount = useRef(0);

  useEffect(() => {
    renderCount.current++;

    if (renderCount.current === 1) {
      LogVault.info(`Component mounted: ${componentName}`, {
        component: componentName,
      });
    }

    return () => {
      LogVault.info(`Component unmounted: ${componentName}`, {
        component: componentName,
        totalRenders: renderCount.current,
      });
    };
  }, [componentName]);

  const trackEvent = useCallback(
    (event: string, metadata?: Metadata) => {
      LogVault.info(`[${componentName}] ${event}`, {
        component: componentName,
        ...metadata,
      });
    },
    [componentName],
  );

  const trackError = useCallback(
    (
      error: Error | string,
      severity: Severity = "MEDIUM",
      metadata?: Metadata,
    ) => {
      const err = typeof error === "string" ? new Error(error) : error;
      LogVault.captureException(err, {
        severity,
        metadata: {
          component: componentName,
          ...metadata,
        },
      });
    },
    [componentName],
  );

  const trackAction = useCallback(
    (action: string, metadata?: Metadata) => {
      LogVault.debug({
        type: "user_action",
        data: {
          component: componentName,
          action,
          ...metadata,
        },
      });
    },
    [componentName],
  );

  return { trackEvent, trackError, trackAction, LogVault };
}
