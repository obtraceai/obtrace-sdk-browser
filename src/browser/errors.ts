import { type Tracer, SpanStatusCode } from "@opentelemetry/api";
import { addBreadcrumb, getBreadcrumbs } from "./breadcrumbs";

export function installBrowserErrorHooks(tracer: Tracer, sessionId?: string): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const onError = (ev: ErrorEvent) => {
    const message = ev.message || "window.error";
    addBreadcrumb({ timestamp: Date.now(), category: "error", message, level: "error" });
    try {
      const breadcrumbs = getBreadcrumbs();
      const stack = ev.error instanceof Error ? ev.error.stack || "" : "";
      const span = tracer.startSpan("browser.error", {
        attributes: {
          "error.message": message,
          "error.file": ev.filename || "",
          "error.line": ev.lineno || 0,
          "error.column": ev.colno || 0,
          "error.stack": stack.slice(0, 4096),
          "error.type": ev.error?.constructor?.name || "Error",
          "breadcrumbs.count": breadcrumbs.length,
          "breadcrumbs.json": JSON.stringify(breadcrumbs.slice(-20)),
          ...(sessionId ? { "session.id": sessionId } : {}),
        },
      });
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      if (ev.error instanceof Error) {
        span.recordException(ev.error);
      }
      span.end();
    } catch {}
  };

  const onRejection = (ev: PromiseRejectionEvent) => {
    let reason: string;
    let stack = "";
    if (ev.reason instanceof Error) {
      reason = `${ev.reason.name}: ${ev.reason.message}`;
      stack = ev.reason.stack || "";
    } else {
      reason = typeof ev.reason === "string" ? ev.reason : JSON.stringify(ev.reason ?? {});
    }
    addBreadcrumb({ timestamp: Date.now(), category: "error", message: reason, level: "error" });
    try {
      const breadcrumbs = getBreadcrumbs();
      const span = tracer.startSpan("browser.unhandledrejection", {
        attributes: {
          "error.message": reason,
          "error.stack": stack.slice(0, 4096),
          "error.type": ev.reason?.constructor?.name || "UnhandledRejection",
          "breadcrumbs.count": breadcrumbs.length,
          "breadcrumbs.json": JSON.stringify(breadcrumbs.slice(-20)),
          ...(sessionId ? { "session.id": sessionId } : {}),
        },
      });
      span.setStatus({ code: SpanStatusCode.ERROR, message: reason });
      if (ev.reason instanceof Error) {
        span.recordException(ev.reason);
      }
      span.end();
    } catch {}
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
