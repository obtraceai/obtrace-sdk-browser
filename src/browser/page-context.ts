import { trace, context, type Context, type Span, type Tracer } from "@opentelemetry/api";
import type { PageRootProcessor } from "./page-root-processor";

let _pageSpan: Span | null = null;
let _pageCtx: Context | null = null;
let _clickSpan: Span | null = null;
let _clickCtx: Context | null = null;
let _clickTimeout: ReturnType<typeof setTimeout> | null = null;
let _processor: PageRootProcessor | null = null;

const CLICK_SPAN_TTL_MS = 3000;

export function setPageRootProcessor(proc: PageRootProcessor): void {
  _processor = proc;
}

export function startPageSpan(tracer: Tracer, sessionId: string): () => void {
  endPageSpan();

  const url = typeof window !== "undefined" ? window.location.href : "";
  _pageSpan = tracer.startSpan("browser.page", {
    attributes: {
      "session.id": sessionId,
      "page.url": url,
      "page.title": typeof document !== "undefined" ? document.title : "",
    },
  });
  _pageCtx = trace.setSpan(context.active(), _pageSpan);

  const sc = _pageSpan.spanContext();
  if (_processor) {
    _processor.setPageSpan(sc.traceId, sc.spanId);
  }

  return endPageSpan;
}

export function endPageSpan(): void {
  endClickSpan();
  if (_pageSpan) {
    _pageSpan.end();
    _pageSpan = null;
    _pageCtx = null;
  }
  if (_processor) {
    _processor.clearPageSpan();
  }
}

export function updatePageURL(): void {
  if (_pageSpan && typeof window !== "undefined") {
    _pageSpan.setAttribute("page.url", window.location.href);
    _pageSpan.setAttribute("page.title", document.title);
  }
}

export function startClickSpan(tracer: Tracer, selector: string, sessionId: string): Span {
  endClickSpan();

  const parentCtx = _pageCtx || context.active();
  _clickSpan = tracer.startSpan(
    "click",
    { attributes: { "click.selector": selector, "session.id": sessionId } },
    parentCtx,
  );
  _clickCtx = trace.setSpan(parentCtx, _clickSpan);

  _clickTimeout = setTimeout(() => {
    endClickSpan();
  }, CLICK_SPAN_TTL_MS);

  return _clickSpan;
}

export function endClickSpan(): void {
  if (_clickTimeout) {
    clearTimeout(_clickTimeout);
    _clickTimeout = null;
  }
  if (_clickSpan) {
    _clickSpan.end();
    _clickSpan = null;
    _clickCtx = null;
  }
}

export function getActiveContext(): Context {
  return _clickCtx || _pageCtx || context.active();
}

export function getPageContext(): Context {
  return _pageCtx || context.active();
}

export function withActiveContext<T>(fn: () => T): T {
  return context.with(getActiveContext(), fn);
}
