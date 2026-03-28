import type { Tracer } from "@opentelemetry/api";
import { addBreadcrumb } from "./breadcrumbs";

const LEVEL_MAP: Record<string, "debug" | "info" | "warn" | "error"> = {
  debug: "debug",
  log: "info",
  info: "info",
  warn: "warn",
  error: "error",
};

let patched = false;
let originals: Record<string, (...args: unknown[]) => void> = {};

export function installConsoleCapture(tracer: Tracer, sessionId: string): () => void {
  if (patched || typeof console === "undefined") return () => {};
  patched = true;

  const methods = ["debug", "log", "info", "warn", "error"] as const;
  originals = {};

  for (const method of methods) {
    const original = console[method].bind(console);
    originals[method] = original;
    const level = LEVEL_MAP[method];

    (console as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      original(...args);

      let message: string;
      let attrs: Record<string, string | number | boolean> = {};

      if (args.length === 1 && typeof args[0] === "object" && args[0] !== null && !Array.isArray(args[0])) {
        const obj = args[0] as Record<string, unknown>;
        message = String(obj.msg || obj.message || JSON.stringify(obj));
        for (const [k, v] of Object.entries(obj)) {
          if (k === "msg" || k === "message") continue;
          if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
            attrs[k] = v;
          }
        }
      } else {
        message = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
      }

      addBreadcrumb({ timestamp: Date.now(), category: `console.${method}`, message, level, data: attrs });

      const span = tracer.startSpan("browser.console", {
        attributes: {
          "log.severity": level.toUpperCase(),
          "log.message": message.slice(0, 1024),
          "session.id": sessionId,
          ...attrs,
        },
      });
      span.end();
    };
  }

  return () => {
    for (const [method, original] of Object.entries(originals)) {
      (console as unknown as Record<string, unknown>)[method] = original;
    }
    originals = {};
    patched = false;
  };
}
