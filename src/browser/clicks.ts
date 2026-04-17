import type { Tracer } from "@opentelemetry/api";
import { addBreadcrumb, getElementSelector } from "./breadcrumbs";
import { startClickSpan, endClickSpan } from "./page-context";

interface ClickEntry {
  selector: string;
  timestamp: number;
}

const RAGE_THRESHOLD = 3;
const RAGE_WINDOW_MS = 1000;
const DEAD_CLICK_TIMEOUT_MS = 2000;
const INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY", "DETAILS"]);

export function installClickTracking(tracer: Tracer, sessionId: string): () => void {
  if (typeof document === "undefined") return () => {};

  const recent: ClickEntry[] = [];
  let pendingDeadCheck: ReturnType<typeof setTimeout> | null = null;
  let networkAfterClick = false;

  const networkListener = () => { networkAfterClick = true; };

  const handler = (ev: MouseEvent) => {
    const target = ev.target as Element | null;
    if (!target) return;
    const selector = getElementSelector(target);
    const now = Date.now();

    addBreadcrumb({
      timestamp: now,
      category: "ui.click",
      message: selector,
      level: "info",
      data: { x: ev.clientX, y: ev.clientY },
    });

    endClickSpan();
    startClickSpan(tracer, selector, sessionId);

    recent.push({ selector, timestamp: now });
    while (recent.length > 0 && now - recent[0].timestamp > RAGE_WINDOW_MS) {
      recent.shift();
    }

    const sameElement = recent.filter(e => e.selector === selector);
    if (sameElement.length >= RAGE_THRESHOLD) {
      recent.length = 0;
      addBreadcrumb({ timestamp: now, category: "ui.rage_click", message: selector, level: "warn" });
      const span = tracer.startSpan("browser.rage_click", {
        attributes: { "click.selector": selector, "click.count": sameElement.length, "session.id": sessionId },
      });
      span.end();
    }

    const isInteractive = INTERACTIVE_TAGS.has(target.tagName) ||
      target.hasAttribute("onclick") ||
      target.hasAttribute("role") ||
      (target as HTMLElement).contentEditable === "true" ||
      target.closest("a, button, [onclick], [role='button']") !== null;

    if (!isInteractive) {
      networkAfterClick = false;
      if (pendingDeadCheck) clearTimeout(pendingDeadCheck);
      pendingDeadCheck = setTimeout(() => {
        if (!networkAfterClick) {
          addBreadcrumb({ timestamp: now, category: "ui.dead_click", message: selector, level: "warn" });
          const span = tracer.startSpan("browser.dead_click", {
            attributes: { "click.selector": selector, "session.id": sessionId },
          });
          span.end();
        }
        pendingDeadCheck = null;
      }, DEAD_CLICK_TIMEOUT_MS);
    }
  };

  document.addEventListener("click", handler, true);
  window.addEventListener("fetch", networkListener);
  const origXhrSend = XMLHttpRequest.prototype.send;
  const xhrWrapper = function (this: XMLHttpRequest, ...args: unknown[]) {
    networkAfterClick = true;
    return origXhrSend.apply(this, args as [body?: Document | XMLHttpRequestBodyInit | null]);
  };
  XMLHttpRequest.prototype.send = xhrWrapper;

  return () => {
    document.removeEventListener("click", handler, true);
    window.removeEventListener("fetch", networkListener);
    XMLHttpRequest.prototype.send = origXhrSend;
    if (pendingDeadCheck) clearTimeout(pendingDeadCheck);
  };
}
