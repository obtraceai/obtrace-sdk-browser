import { type Tracer, SpanStatusCode } from "@opentelemetry/api";

export function installBrowserErrorHooks(tracer: Tracer, sessionId?: string): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const onError = (ev: ErrorEvent) => {
    const span = tracer.startSpan("browser.error", {
      attributes: {
        "error.message": ev.message || "window.error",
        "error.file": ev.filename || "",
        "error.line": ev.lineno || 0,
        "error.column": ev.colno || 0,
        ...(sessionId ? { "session.id": sessionId } : {}),
      },
    });
    span.setStatus({ code: SpanStatusCode.ERROR, message: ev.message });
    if (ev.error instanceof Error) {
      span.recordException(ev.error);
    }
    span.end();
  };

  const onRejection = (ev: PromiseRejectionEvent) => {
    const reason = typeof ev.reason === "string" ? ev.reason : JSON.stringify(ev.reason ?? {});
    const span = tracer.startSpan("browser.unhandledrejection", {
      attributes: {
        "error.message": reason,
        ...(sessionId ? { "session.id": sessionId } : {}),
      },
    });
    span.setStatus({ code: SpanStatusCode.ERROR, message: reason });
    if (ev.reason instanceof Error) {
      span.recordException(ev.reason);
    }
    span.end();
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
