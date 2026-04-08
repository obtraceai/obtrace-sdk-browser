import { type Tracer, SpanStatusCode } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import type { Logger } from "@opentelemetry/api-logs";
import { addBreadcrumb, getBreadcrumbs } from "./breadcrumbs";

let processing = false;

export function installBrowserErrorHooks(tracer: Tracer, logger: Logger, sessionId?: string): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const onError = (ev: ErrorEvent) => {
    if (processing) return;
    const message = ev.message || "window.error";
    addBreadcrumb({ timestamp: Date.now(), category: "error", message, level: "error" });
    try {
      processing = true;
      const breadcrumbs = getBreadcrumbs();
      const stack = ev.error instanceof Error ? ev.error.stack || "" : "";
      const errorType = ev.error?.constructor?.name || "Error";
      const attrs: Record<string, string | number> = {
        "error.message": message,
        "error.file": ev.filename || "",
        "error.line": ev.lineno || 0,
        "error.column": ev.colno || 0,
        "error.stack": stack.slice(0, 4096),
        "error.type": errorType,
        "breadcrumbs.count": breadcrumbs.length,
        "breadcrumbs.json": JSON.stringify(breadcrumbs.slice(-5)),
        ...(sessionId ? { "session.id": sessionId } : {}),
      };

      logger.emit({
        severityNumber: SeverityNumber.ERROR,
        severityText: "ERROR",
        body: message,
        attributes: {
          "log.source": "window.error",
          ...attrs,
        },
      });

      const span = tracer.startSpan("browser.error", { attributes: attrs });
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      if (ev.error instanceof Error) {
        span.recordException(ev.error);
      }
      span.end();
    } catch {} finally { processing = false; }
  };

  const onRejection = (ev: PromiseRejectionEvent) => {
    if (processing) return;
    let reason: string;
    let stack = "";
    let errorType = "UnhandledRejection";
    if (ev.reason instanceof Error) {
      reason = `${ev.reason.name}: ${ev.reason.message}`;
      stack = ev.reason.stack || "";
      errorType = ev.reason.constructor?.name || "Error";
    } else {
      reason = typeof ev.reason === "string" ? ev.reason : JSON.stringify(ev.reason ?? {});
    }
    addBreadcrumb({ timestamp: Date.now(), category: "error", message: reason, level: "error" });
    try {
      processing = true;
      const breadcrumbs = getBreadcrumbs();
      const attrs: Record<string, string | number> = {
        "error.message": reason,
        "error.stack": stack.slice(0, 4096),
        "error.type": errorType,
        "breadcrumbs.count": breadcrumbs.length,
        "breadcrumbs.json": JSON.stringify(breadcrumbs.slice(-5)),
        ...(sessionId ? { "session.id": sessionId } : {}),
      };

      logger.emit({
        severityNumber: SeverityNumber.ERROR,
        severityText: "ERROR",
        body: reason,
        attributes: {
          "log.source": "unhandledrejection",
          ...attrs,
        },
      });

      const span = tracer.startSpan("browser.unhandledrejection", { attributes: attrs });
      span.setStatus({ code: SpanStatusCode.ERROR, message: reason });
      if (ev.reason instanceof Error) {
        span.recordException(ev.reason);
      }
      span.end();
    } catch {} finally { processing = false; }
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
