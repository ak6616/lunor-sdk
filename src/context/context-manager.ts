import { LogContext, Metadata } from "../types";

/**
 * Manages contextual data that gets attached to every event.
 * Supports scoped contexts (e.g., per-request).
 */
export class ContextManager {
  private globalContext: LogContext = {};
  private scopeStack: LogContext[] = [];

  setGlobalContext(ctx: Partial<LogContext>): void {
    this.globalContext = { ...this.globalContext, ...ctx };
  }

  clearGlobalContext(): void {
    this.globalContext = {};
  }

  pushScope(ctx: LogContext): void {
    this.scopeStack.push(ctx);
  }

  popScope(): LogContext | undefined {
    return this.scopeStack.pop();
  }

  getContext(): LogContext {
    const merged: LogContext = { ...this.globalContext };

    for (const scope of this.scopeStack) {
      Object.assign(merged, scope);

      // Merge tags
      if (scope.tags) {
        merged.tags = [...(merged.tags || []), ...scope.tags];
      }

      // Deep merge extra
      if (scope.extra) {
        merged.extra = { ...(merged.extra || {}), ...scope.extra };
      }
    }

    return merged;
  }

  getContextAsMetadata(): Metadata {
    const ctx = this.getContext();
    const meta: Metadata = {};

    if (ctx.userId) meta._userId = ctx.userId;
    if (ctx.sessionId) meta._sessionId = ctx.sessionId;
    if (ctx.requestId) meta._requestId = ctx.requestId;
    if (ctx.traceId) meta._traceId = ctx.traceId;
    if (ctx.tags && ctx.tags.length > 0) meta._tags = ctx.tags;
    if (ctx.extra) Object.assign(meta, ctx.extra);

    return meta;
  }
}
