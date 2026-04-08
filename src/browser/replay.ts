import type { eventWithTime } from "@rrweb/types";
import { EventType } from "@rrweb/types";
import type { HTTPRecord, ReplayChunk, ReplayStep } from "../shared/types";
import { sanitizeHeaders, stripQuery, toBase64 } from "../shared/utils";

const KEY_OVERHEAD = 6;

function estimateObjectBytes(value: unknown, depth = 0): number {
  if (depth > 8 || value === null || value === undefined) return 4;
  switch (typeof value) {
    case "string":
      return (value as string).length + 2;
    case "number":
    case "boolean":
      return 8;
    case "object": {
      if (Array.isArray(value)) {
        let sum = 2;
        for (let i = 0; i < value.length; i++) {
          sum += estimateObjectBytes(value[i], depth + 1) + 1;
        }
        return sum;
      }
      let sum = 2;
      const keys = Object.keys(value as Record<string, unknown>);
      for (let i = 0; i < keys.length; i++) {
        sum += keys[i].length + KEY_OVERHEAD + estimateObjectBytes((value as Record<string, unknown>)[keys[i]], depth + 1);
      }
      return sum;
    }
    default:
      return 4;
  }
}

export interface ReplayBufferConfig {
  maxChunkBytes: number;
  flushIntervalMs: number;
  sessionStorageKey: string;
}

export class BrowserReplayBuffer {
  private readonly cfg: ReplayBufferConfig;
  private readonly replayId: string;
  private seq = 0;
  private events: eventWithTime[] = [];
  private bytesEstimate: number = 0;
  private chunkStartedAt = Date.now();

  constructor(cfg: ReplayBufferConfig) {
    this.cfg = cfg;
    this.replayId = this.resolveReplayId();
  }

  get sessionId(): string {
    return this.replayId;
  }

  pushRrwebEvent(event: eventWithTime): ReplayChunk | null {
    this.events.push(event);
    this.bytesEstimate += estimateObjectBytes(event);
    if (this.bytesEstimate >= this.cfg.maxChunkBytes) {
      return this.flush();
    }
    return null;
  }

  pushCustomEvent(tag: string, payload: Record<string, unknown>): ReplayChunk | null {
    const event: eventWithTime = {
      type: EventType.Custom,
      data: { tag, payload },
      timestamp: Date.now(),
    };
    return this.pushRrwebEvent(event);
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
      events: this.events,
    };

    this.seq += 1;
    this.events = [];
    this.bytesEstimate = 0;
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
      body_b64: body_b64 || undefined,
    };
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
      res_body_b64: record.res_body_b64,
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
