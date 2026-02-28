import type { ObtraceClient } from "../core/client";

export function installBrowserErrorHooks(client: ObtraceClient, sessionId?: string): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const onError = (ev: ErrorEvent) => {
    client.log("error", ev.message || "window.error", {
      sessionId,
      attrs: {
        file: ev.filename || "",
        line: ev.lineno || 0,
        column: ev.colno || 0
      }
    });
  };

  const onRejection = (ev: PromiseRejectionEvent) => {
    const reason = typeof ev.reason === "string" ? ev.reason : JSON.stringify(ev.reason ?? {});
    client.log("error", `unhandledrejection: ${reason}`, {
      sessionId
    });
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
