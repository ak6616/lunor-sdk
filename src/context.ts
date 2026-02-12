// src/context.ts

import type { ContextData, LunorConfig } from "./types";
import { detectRuntime, isBrowser, isNode } from "./utils";

/**
 * Automatically collect context data about the environment
 */
export function collectContext(config: LunorConfig): ContextData {
  const runtime = detectRuntime();

  const context: ContextData = {
    environment: config.environment,
    release: config.release,
    tags: config.tags,
    runtime,
  };

  if (isBrowser()) {
    collectBrowserContext(context);
  }

  if (isNode()) {
    collectNodeContext(context);
  }

  return context;
}

function collectBrowserContext(context: ContextData): void {
  try {
    context.userAgent = navigator.userAgent;
    context.url = window.location.href;
    context.locale = navigator.language;
    context.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    if (window.screen) {
      context.screenResolution = `${window.screen.width}x${window.screen.height}`;
    }

    context.os = extractOSFromUA(navigator.userAgent);
  } catch {
    // Silently fail — some of these may not be available
  }
}

function collectNodeContext(context: ContextData): void {
  try {
    const os = require("os");
    context.hostname = os.hostname();
    context.os = `${os.platform()} ${os.release()}`;
    context.nodeVersion = process.version;
    context.pid = process.pid;

    const mem = process.memoryUsage();
    context.memoryUsage = {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      external: Math.round(mem.external / 1024 / 1024),
    };
  } catch {
    // Silently fail
  }
}

function extractOSFromUA(ua: string): string {
  if (ua.includes("Windows")) return "Windows";
  if (ua.includes("Mac OS")) return "macOS";
  if (ua.includes("Linux")) return "Linux";
  if (ua.includes("Android")) return "Android";
  if (ua.includes("iOS") || ua.includes("iPhone") || ua.includes("iPad"))
    return "iOS";
  return "Unknown";
}
