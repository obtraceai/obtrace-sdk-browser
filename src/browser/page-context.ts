import { ROOT_CONTEXT, type Span, type Tracer } from "@opentelemetry/api";

let _pageSpan: Span | null = null;
let _clickSpan: Span | null = null;
let _clickTimeout: ReturnType<typeof setTimeout> | null = null;

const CLICK_SPAN_TTL_MS = 3000;

export function startPageSpan(tracer: Tracer, sessionId: string): () => void {
  endPageSpan();

  const url = typeof window !== "undefined" ? window.location.href : "";
  _pageSpan = tracer.startSpan(
    "browser.page",
    {
      attributes: {
        "session.id": sessionId,
        "page.url": url,
        "page.title": typeof document !== "undefined" ? document.title : "",
      },
    },
    ROOT_CONTEXT,
  );

  return endPageSpan;
}

export function endPageSpan(): void {
  endClickSpan();
  if (_pageSpan) {
    _pageSpan.end();
    _pageSpan = null;
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

  _clickSpan = tracer.startSpan(
    "click",
    { attributes: { "click.selector": selector, "session.id": sessionId } },
    ROOT_CONTEXT,
  );

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
  }
}
