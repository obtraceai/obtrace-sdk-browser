import type { Span, SpanProcessor, ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { Context } from "@opentelemetry/api";

export class PageRootProcessor implements SpanProcessor {
  private _pageTraceId: string | null = null;
  private _pageSpanId: string | null = null;

  setPageSpan(traceId: string, spanId: string): void {
    this._pageTraceId = traceId;
    this._pageSpanId = spanId;
  }

  clearPageSpan(): void {
    this._pageTraceId = null;
    this._pageSpanId = null;
  }

  onStart(span: Span, _parentContext: Context): void {
    if (!this._pageTraceId || !this._pageSpanId) return;

    const ctx = span.spanContext();
    if (ctx.traceId === this._pageTraceId) return;

    const raw = span as any;
    if (raw.parentSpanId && raw.parentSpanId !== "0000000000000000") return;

    raw.parentSpanId = this._pageSpanId;

    if (raw._spanContext && typeof raw._spanContext === "object") {
      raw._spanContext = { ...raw._spanContext, traceId: this._pageTraceId };
    }
  }

  onEnd(_span: ReadableSpan): void {}

  async shutdown(): Promise<void> {
    this.clearPageSpan();
  }

  async forceFlush(): Promise<void> {}
}
