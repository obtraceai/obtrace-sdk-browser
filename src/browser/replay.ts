import type { HTTPRecord, ReplayChunk, ReplayChunkEvent, ReplayStep } from "../shared/types";
import { sanitizeHeaders, stripQuery, toBase64 } from "../shared/utils";

export interface ReplayBufferConfig {
  maxChunkBytes: number;
  flushIntervalMs: number;
  sessionStorageKey: string;
}

export class BrowserReplayBuffer {
  private readonly cfg: ReplayBufferConfig;
  private readonly replayId: string;
  private seq = 0;
  private events: ReplayChunkEvent[] = [];
  private chunkStartedAt = Date.now();

  constructor(cfg: ReplayBufferConfig) {
    this.cfg = cfg;
    this.replayId = this.resolveReplayId();
  }

  get sessionId(): string {
    return this.replayId;
  }

  push(type: string, payload: Record<string, unknown>): ReplayChunk | null {
    this.events.push({ t: Date.now(), type, payload });
    if (this.currentBytes() >= this.cfg.maxChunkBytes) {
      return this.flush();
    }
    return null;
  }

  flush(): ReplayChunk | null {
    if (!this.events.length) {
      return null;
    }

    const out: ReplayChunk = {
      replay_id: this.replayId,
      seq: this.seq,
      started_at_ms: this.chunkStartedAt,
      ended_at_ms: Date.now(),
      events: this.events
    };

    this.seq += 1;
    this.events = [];
    this.chunkStartedAt = Date.now();
    return out;
  }

  toRecipeStep(index: number, record: HTTPRecord): ReplayStep {
    const safeReqHeaders = sanitizeHeaders(record.req_headers);
    let body_b64 = "";
    if (record.req_body_b64) {
      body_b64 = record.req_body_b64;
    }
    return {
      step_id: index,
      method: record.method,
      url_template: stripQuery(record.url),
      headers: safeReqHeaders,
      body_b64: body_b64 || undefined
    };
  }

  captureInitialDOMSnapshot(doc: Document): ReplayChunk | null {
    const html = sanitizeDOMHTML(doc.documentElement.outerHTML);
    return this.push("dom_snapshot", {
      url: doc.location?.href ?? "",
      title: doc.title ?? "",
      viewport: {
        w: window.innerWidth,
        h: window.innerHeight
      },
      html
    });
  }

  captureDOMMutation(event: {
    kind: "childList" | "attributes" | "characterData";
    targetPath: string;
    addedHTML?: string[];
    removedPaths?: string[];
    attributeName?: string;
    attributeValue?: string | null;
    textContent?: string;
  }): ReplayChunk | null {
    return this.push("dom_mutation", event as unknown as Record<string, unknown>);
  }

  captureInput(event: { targetPath: string; value: string; inputType: string }): ReplayChunk | null {
    return this.push("dom_input", {
      targetPath: event.targetPath,
      value: sanitizeInputValue(event.value),
      inputType: event.inputType
    });
  }

  captureScroll(event: { x: number; y: number; path: string }): ReplayChunk | null {
    return this.push("dom_scroll", event as unknown as Record<string, unknown>);
  }

  captureViewport(event: { w: number; h: number }): ReplayChunk | null {
    return this.push("dom_viewport", event as unknown as Record<string, unknown>);
  }

  asNetworkEvent(record: HTTPRecord): Record<string, unknown> {
    return {
      method: record.method,
      url: stripQuery(record.url),
      status: record.status,
      dur_ms: record.dur_ms,
      req_headers: sanitizeHeaders(record.req_headers),
      res_headers: sanitizeHeaders(record.res_headers),
      req_body_b64: record.req_body_b64,
      res_body_b64: record.res_body_b64
    };
  }

  encodeBody(body: unknown): string | undefined {
    if (typeof body === "string") {
      return toBase64(body);
    }
    if (body && typeof body === "object") {
      return toBase64(JSON.stringify(body));
    }
    return undefined;
  }

  private currentBytes(): number {
    return JSON.stringify(this.events).length;
  }

  private resolveReplayId(): string {
    if (typeof window === "undefined") {
      return `srv-${Date.now()}`;
    }

    const ls = window.localStorage;
    const existing = ls.getItem(this.cfg.sessionStorageKey);
    if (existing) {
      return existing;
    }

    const next = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    ls.setItem(this.cfg.sessionStorageKey, next);
    return next;
  }
}

function sanitizeDOMHTML(html: string): string {
  let out = html;
  out = out.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "");
  out = out.replace(/<noscript[\s\S]*?>[\s\S]*?<\/noscript>/gi, "");
  out = out.replace(/\s(on[a-z]+)=["'][^"']*["']/gi, "");
  out = out.replace(/(value)=["'][^"']*["']/gi, "$1=\"[redacted]\"");
  return out;
}

function sanitizeInputValue(value: string): string {
  if (!value) {
    return "";
  }
  if (value.length > 256) {
    return `${value.slice(0, 256)}...[truncated]`;
  }
  return value;
}
