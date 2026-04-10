import { type Tracer, SpanStatusCode } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import type { Logger } from "@opentelemetry/api-logs";
import { addBreadcrumb } from "./breadcrumbs";
import { getPageContext } from "./page-context";

const LEVEL_MAP: Record<string, "debug" | "info" | "warn" | "error"> = {
  debug: "debug",
  log: "info",
  info: "info",
  warn: "warn",
  error: "error",
};

const SEVERITY_MAP: Record<string, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  log: SeverityNumber.INFO,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

let patched = false;
let originals: Record<string, (...args: unknown[]) => void> = {};
let emitting = false;

export function installConsoleCapture(tracer: Tracer, logger: Logger, sessionId: string): () => void {
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
      if (emitting) return;
      try {
        emitting = true;
        let message: string;
        let attrs: Record<string, string | number | boolean> = {};

        const safeStringify = (v: unknown): string => {
          try { return JSON.stringify(v); } catch { return String(v); }
        };

        const firstArg = args[0];
        const isErrorObj = firstArg instanceof Error;

        if (isErrorObj) {
          const err = firstArg;
          message = `${err.name}: ${err.message}`;
          if (err.stack) attrs["error.stack"] = err.stack.slice(0, 4096);
          attrs["error.type"] = err.name;
          for (let i = 1; i < args.length; i++) {
            const extra = args[i];
            if (typeof extra === "string" && extra.includes("\n    at ")) {
              attrs["error.component_stack"] = extra.slice(0, 4096);
            }
          }
        } else if (args.length === 1 && typeof firstArg === "object" && firstArg !== null && !Array.isArray(firstArg)) {
          const obj = firstArg as Record<string, unknown>;
          message = String(obj.msg || obj.message || safeStringify(obj));
          for (const [k, v] of Object.entries(obj)) {
            if (k === "msg" || k === "message") continue;
            if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
              attrs[k] = v;
            }
          }
        } else {
          message = args.map(a => typeof a === "string" ? a : safeStringify(a)).join(" ");
          if (method === "error") {
            for (const a of args) {
              if (typeof a === "string" && a.includes("\n    at ")) {
                attrs["error.stack"] = a.slice(0, 4096);
                break;
              }
            }
          }
        }

        addBreadcrumb({ timestamp: Date.now(), category: `console.${method}`, message, level, data: attrs });

        logger.emit({
          severityNumber: SEVERITY_MAP[method] ?? SeverityNumber.INFO,
          severityText: level.toUpperCase(),
          body: message.slice(0, 4096),
          attributes: {
            "session.id": sessionId,
            "log.source": "console",
            ...attrs,
          },
        });

        if (method === "error") {
          const spanName = (isErrorObj || attrs["error.stack"]) ? "browser.error" : "browser.console";
          const span = tracer.startSpan(spanName, {
            attributes: {
              "error.message": message.slice(0, 1024),
              "session.id": sessionId,
              ...attrs,
            },
          }, getPageContext());
          span.setStatus({ code: SpanStatusCode.ERROR, message: message.slice(0, 1024) });
          if (isErrorObj) span.recordException(firstArg);
          span.end();
        }
      } catch {} finally { emitting = false; }
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
