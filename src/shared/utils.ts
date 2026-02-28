export function nowUnixNano(): string {
  const ms = BigInt(Date.now());
  return (ms * 1_000_000n).toString();
}

export function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomHex(lenBytes: number): string {
  const out = new Uint8Array(lenBytes);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(out);
  } else {
    for (let i = 0; i < lenBytes; i += 1) {
      out[i] = Math.floor(Math.random() * 256);
    }
  }
  return hex(out);
}

export function toBase64(input: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(input, "utf8").toString("base64");
  }
  if (typeof btoa !== "undefined") {
    return btoa(unescape(encodeURIComponent(input)));
  }
  throw new Error("base64 encoder unavailable");
}

export function truncate(input: string, max: number): string {
  if (input.length <= max) {
    return input;
  }
  return input.slice(0, max);
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
}

export function sanitizeHeaders(headers: Record<string, string> | Headers | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const deny = new Set(["authorization", "cookie", "set-cookie", "x-api-key", "api-key"]);

  if (!headers) {
    return out;
  }

  if (headers instanceof Headers) {
    headers.forEach((v, k) => {
      if (!deny.has(k.toLowerCase())) {
        out[k] = v;
      }
    });
    return out;
  }

  for (const [k, v] of Object.entries(headers)) {
    if (!deny.has(k.toLowerCase())) {
      out[k] = v;
    }
  }
  return out;
}

export function stripQuery(url: string): string {
  try {
    const u = new URL(url, "http://local");
    u.search = "";
    if (u.origin === "http://local") {
      return `${u.pathname}${u.hash}`;
    }
    return u.toString();
  } catch {
    return url;
  }
}

export function createTraceparent(traceId?: string, spanId?: string): string {
  const t = traceId && traceId.length === 32 ? traceId : randomHex(16);
  const s = spanId && spanId.length === 16 ? spanId : randomHex(8);
  return `00-${t}-${s}-01`;
}

export function parseTraceparent(value: string | null | undefined): { traceId: string; parentSpanId: string; flags: string } | null {
  if (!value) {
    return null;
  }
  const m = value.trim().match(/^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i);
  if (!m) {
    return null;
  }
  return {
    traceId: m[2].toLowerCase(),
    parentSpanId: m[3].toLowerCase(),
    flags: m[4].toLowerCase()
  };
}

export interface PropagationHeaders {
  traceId?: string;
  parentSpanId?: string;
  traceState?: string;
  baggage?: string;
}

function readHeader(headers: Headers, key: string): string | undefined {
  const v = headers.get(key);
  if (!v) {
    return undefined;
  }
  return v;
}

export function extractPropagation(headers?: HeadersInit): PropagationHeaders {
  const h = new Headers(headers);
  const tp = parseTraceparent(readHeader(h, "traceparent"));
  return {
    traceId: tp?.traceId,
    parentSpanId: tp?.parentSpanId,
    traceState: readHeader(h, "tracestate"),
    baggage: readHeader(h, "baggage")
  };
}
