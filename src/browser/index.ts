import { record } from "rrweb";
import { ObtraceClient } from "../core/client";
import type { HTTPRecord, ObtraceSDKConfig, ReplayStep, SDKContext } from "../shared/types";
import { extractPropagation, nowUnixNano, randomHex, sanitizeHeaders } from "../shared/utils";
import { installBrowserErrorHooks } from "./errors";
import { BrowserReplayBuffer } from "./replay";
import { installWebVitals } from "./vitals";

export interface BrowserSDK {
  client: ObtraceClient;
  sessionId: string;
  log: (level: "debug" | "info" | "warn" | "error" | "fatal", message: string, context?: SDKContext) => void;
  metric: (name: string, value: number, unit?: string, context?: SDKContext) => void;
  captureException: (error: unknown, context?: SDKContext) => void;
  captureError: (error: unknown, context?: SDKContext) => void;
  captureReplayEvent: (type: string, payload: Record<string, unknown>) => void;
  flushReplay: () => void;
  captureRecipe: (step: ReplayStep) => void;
  instrumentFetch: () => (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  shutdown: () => Promise<void>;
}

interface InstanceEntry {
  client: ObtraceClient;
  sessionId: string;
  replay: BrowserReplayBuffer;
  config: ObtraceSDKConfig;
  recipeSteps: ReplayStep[];
}

const instances = new Set<InstanceEntry>();

let activeTraceContext: { traceId: string; spanId: string } | null = null;
const replayBuffers = new Set<BrowserReplayBuffer>();

let consolePatched = false;
let originalConsole: {
  debug: typeof console.debug;
  info: typeof console.info;
  warn: typeof console.warn;
  error: typeof console.error;
} | null = null;

let navigationPatched = false;
let originalPushState: History["pushState"] | null = null;
let originalReplaceState: History["replaceState"] | null = null;
let navigationPopstateHandler: (() => void) | null = null;
let navigationHashchangeHandler: (() => void) | null = null;

let rrwebRecording = false;
let stopRrwebRecording: (() => void) | null = null;

function installSharedConsoleCapture(): void {
  if (consolePatched || typeof window === "undefined") {
    return;
  }
  consolePatched = true;
  originalConsole = {
    debug: console.debug.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  const orig = originalConsole;
  console.debug = (...args: unknown[]) => {
    const msg = args.map(String).join(" ");
    const trace = activeTraceContext;
    for (const entry of instances) {
      entry.client.log("debug", msg, { sessionId: entry.sessionId, traceId: trace?.traceId, spanId: trace?.spanId });
    }
    orig.debug(...args);
  };
  console.info = (...args: unknown[]) => {
    const msg = args.map(String).join(" ");
    const trace = activeTraceContext;
    for (const entry of instances) {
      entry.client.log("info", msg, { sessionId: entry.sessionId, traceId: trace?.traceId, spanId: trace?.spanId });
    }
    orig.info(...args);
  };
  console.warn = (...args: unknown[]) => {
    const msg = args.map(String).join(" ");
    const trace = activeTraceContext;
    for (const entry of instances) {
      entry.client.log("warn", msg, { sessionId: entry.sessionId, traceId: trace?.traceId, spanId: trace?.spanId });
    }
    orig.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    const msg = args.map(String).join(" ");
    const trace = activeTraceContext;
    for (const entry of instances) {
      entry.client.log("error", msg, { sessionId: entry.sessionId, traceId: trace?.traceId, spanId: trace?.spanId });
    }
    orig.error(...args);
  };
}

function teardownSharedConsoleCapture(): void {
  if (!consolePatched || !originalConsole) {
    return;
  }
  console.debug = originalConsole.debug;
  console.info = originalConsole.info;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  originalConsole = null;
  consolePatched = false;
}

function fanOutNavigation(): void {
  for (const entry of instances) {
    const chunk = entry.replay.pushCustomEvent("navigation", {
      href: window.location.href,
      title: document.title,
    });
    if (chunk) {
      entry.client.replayChunk(chunk);
    }
  }
}

function installSharedNavigationTracker(): void {
  if (navigationPatched || typeof window === "undefined") {
    return;
  }
  navigationPatched = true;

  const historyRef = window.history;
  originalPushState = historyRef.pushState.bind(historyRef);
  originalReplaceState = historyRef.replaceState.bind(historyRef);
  const rawPush = originalPushState;
  const rawReplace = originalReplaceState;

  historyRef.pushState = ((...args: unknown[]) => {
    rawPush(...(args as [data: unknown, unused: string, url?: string | URL | null]));
    fanOutNavigation();
  }) as History["pushState"];

  historyRef.replaceState = ((...args: unknown[]) => {
    rawReplace(...(args as [data: unknown, unused: string, url?: string | URL | null]));
    fanOutNavigation();
  }) as History["replaceState"];

  navigationPopstateHandler = fanOutNavigation;
  navigationHashchangeHandler = fanOutNavigation;
  window.addEventListener("popstate", navigationPopstateHandler);
  window.addEventListener("hashchange", navigationHashchangeHandler);
}

function teardownSharedNavigationTracker(): void {
  if (!navigationPatched || typeof window === "undefined") {
    return;
  }
  if (originalPushState) {
    window.history.pushState = originalPushState;
  }
  if (originalReplaceState) {
    window.history.replaceState = originalReplaceState;
  }
  if (navigationPopstateHandler) {
    window.removeEventListener("popstate", navigationPopstateHandler);
  }
  if (navigationHashchangeHandler) {
    window.removeEventListener("hashchange", navigationHashchangeHandler);
  }
  originalPushState = null;
  originalReplaceState = null;
  navigationPopstateHandler = null;
  navigationHashchangeHandler = null;
  navigationPatched = false;
}

function installSharedRrwebRecording(config: ObtraceSDKConfig): void {
  if (rrwebRecording || typeof window === "undefined") {
    return;
  }
  rrwebRecording = true;

  const replayCfg = config.replay ?? { enabled: true };
  const stop = record({
    emit(event) {
      for (const buf of replayBuffers) {
        const chunk = buf.pushRrwebEvent(event);
        if (chunk) {
          for (const entry of instances) {
            if (entry.replay === buf) {
              entry.client.replayChunk(chunk);
              break;
            }
          }
        }
      }
    },
    maskAllInputs: replayCfg.maskAllInputs ?? true,
    maskInputOptions: {
      password: true,
      email: true,
      tel: true,
    },
    maskInputFn: (text, element) => {
      const el = element as HTMLInputElement;
      const n = (el?.name || "").toLowerCase();
      const id = (el?.id || "").toLowerCase();
      if (/(pass|token|secret|key|email|cpf|ssn|credit|card)/.test(`${n} ${id}`)) {
        return "[redacted]";
      }
      return text;
    },
    blockClass: replayCfg.blockClass ?? "ob-block",
    maskTextClass: replayCfg.maskTextClass ?? "ob-mask",
    inlineStylesheet: true,
    collectFonts: false,
    sampling: {
      mousemove: replayCfg.sampling?.mousemove ?? true,
      mouseInteraction: true,
      scroll: replayCfg.sampling?.scroll ?? 150,
      input: replayCfg.sampling?.input ?? "last",
    },
  });

  if (stop) {
    stopRrwebRecording = stop;
  }
}

function teardownSharedRrwebRecording(): void {
  if (!rrwebRecording) {
    return;
  }
  if (stopRrwebRecording) {
    stopRrwebRecording();
    stopRrwebRecording = null;
  }
  rrwebRecording = false;
}

export function initBrowserSDK(config: ObtraceSDKConfig): BrowserSDK {
  const client = new ObtraceClient({
    ...config,
    replay: {
      enabled: true,
      flushIntervalMs: 5000,
      maxChunkBytes: 480_000,
      captureNetworkRecipes: true,
      sessionStorageKey: "obtrace_session_id",
      ...config.replay,
    },
    vitals: {
      enabled: true,
      reportAllChanges: false,
      ...config.vitals,
    },
    propagation: {
      enabled: true,
      ...config.propagation,
    },
  });

  const replay = new BrowserReplayBuffer({
    maxChunkBytes: config.replay?.maxChunkBytes ?? 480_000,
    flushIntervalMs: config.replay?.flushIntervalMs ?? 5000,
    sessionStorageKey: config.replay?.sessionStorageKey ?? "obtrace_session_id",
  });

  const recipeSteps: ReplayStep[] = [];
  const cleanups: Array<() => void> = [];

  const entry: InstanceEntry = {
    client,
    sessionId: replay.sessionId,
    replay,
    config,
    recipeSteps,
  };

  instances.add(entry);
  replayBuffers.add(replay);

  if (config.vitals?.enabled !== false) {
    cleanups.push(installWebVitals(client, !!config.vitals?.reportAllChanges));
  }

  cleanups.push(installBrowserErrorHooks(client, replay.sessionId));

  installSharedConsoleCapture();

  if (config.replay?.enabled !== false && typeof window !== "undefined") {
    installSharedRrwebRecording(config);
    installSharedNavigationTracker();
  }

  client.replayTimer = setInterval(() => {
    const chunk = replay.flush();
    if (chunk) {
      client.replayChunk(chunk);
    }
  }, config.replay?.flushIntervalMs ?? 5000);
  const replayTimer = client.replayTimer;
  const sendViaBeacon = () => {
    const chunk = replay.flush();
    if (chunk) {
      const url = `${config.ingestBaseUrl?.replace(/\/$/, "")}/ingest/replay/chunk`;
      const blob = new Blob([JSON.stringify(chunk)], { type: "application/json" });
      navigator.sendBeacon(url, blob);
    }
  };
  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      flushReplay();
      client.flush().catch(() => {});
    }
  };
  const onBeforeUnload = () => {
    sendViaBeacon();
    client.flush().catch(() => {});
  };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
    cleanups.push(() => document.removeEventListener("visibilitychange", onVisibility));
  }
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", onBeforeUnload);
    cleanups.push(() => window.removeEventListener("beforeunload", onBeforeUnload));
  }

  const log = (level: "debug" | "info" | "warn" | "error" | "fatal", message: string, context?: SDKContext) => {
    const ctx: SDKContext = { ...context, sessionId: replay.sessionId };
    if (!ctx.traceId && activeTraceContext) {
      ctx.traceId = activeTraceContext.traceId;
      ctx.spanId = activeTraceContext.spanId;
    }
    client.log(level, message, ctx);
  };

  const captureException = (error: unknown, context?: SDKContext) => {
    const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const ctx: SDKContext = { ...context, sessionId: replay.sessionId };
    if (!ctx.traceId && activeTraceContext) {
      ctx.traceId = activeTraceContext.traceId;
      ctx.spanId = activeTraceContext.spanId;
    }
    client.log("error", msg, ctx);
  };

  const captureReplayEvent = (type: string, payload: Record<string, unknown>) => {
    const chunk = replay.pushCustomEvent(type, payload);
    if (chunk) {
      client.replayChunk(chunk);
    }
  };

  const flushReplay = () => {
    const chunk = replay.flush();
    if (chunk) {
      client.replayChunk(chunk);
    }
    if (recipeSteps.length) {
      client.replayRecipes(recipeSteps.splice(0, recipeSteps.length));
    }
  };

  const captureRecipe = (step: ReplayStep) => {
    recipeSteps.push(step);
    if (recipeSteps.length >= 50) {
      client.replayRecipes(recipeSteps.splice(0, recipeSteps.length));
    }
  };

  const instrumentFetch = () => {
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? "GET").toUpperCase();
      const startedMs = Date.now();
      const startedNs = nowUnixNano();
      const requestUrl = typeof input === "string" ? input : input.toString();
      const incoming = extractPropagation(init?.headers);
      const traceId = incoming?.traceId ?? randomHex(16);
      const spanId = randomHex(8);
      activeTraceContext = { traceId, spanId };

      const headers = client.injectPropagation(init?.headers, {
        traceId,
        spanId,
        traceState: incoming.traceState,
        baggage: incoming.baggage,
        sessionId: replay.sessionId,
      });

      const reqBody = init?.body && typeof init.body === "string" ? init.body : undefined;
      try {
        const response = await fetch(input, { ...init, headers });
        const duration = Date.now() - startedMs;

        const netRec: HTTPRecord = {
          ts: Date.now(),
          method,
          url: requestUrl,
          status: response.status,
          dur_ms: duration,
          req_headers: sanitizeHeaders(headers),
          res_headers: sanitizeHeaders(response.headers),
          req_body_b64: reqBody ? replay.encodeBody(reqBody) : undefined,
        };

        captureReplayEvent("network", replay.asNetworkEvent(netRec));
        if (config.replay?.captureNetworkRecipes !== false) {
          captureRecipe(replay.toRecipeStep(recipeSteps.length + 1, netRec));
        }

        client.log("info", `fetch ${method} ${requestUrl} -> ${response.status}`, {
          traceId,
          spanId,
          sessionId: replay.sessionId,
          method,
          endpoint: requestUrl,
          statusCode: response.status,
          attrs: { duration_ms: duration },
        });
        client.span({
          name: `browser.fetch ${method}`,
          traceId,
          spanId,
          parentSpanId: incoming?.parentSpanId,
          startUnixNano: startedNs,
          endUnixNano: nowUnixNano(),
          statusCode: response.status,
          attrs: {
            "http.method": method,
            "http.url": requestUrl,
            "http.status_code": response.status,
            "http.duration_ms": duration,
            "replay.id": replay.sessionId,
            "replay_id": replay.sessionId,
          },
        });

        return response;
      } catch (err) {
        const duration = Date.now() - startedMs;
        client.log("error", `fetch ${method} ${requestUrl} failed: ${String(err)}`, {
          traceId,
          spanId,
          sessionId: replay.sessionId,
          method,
          endpoint: requestUrl,
          attrs: { duration_ms: duration },
        });
        client.span({
          name: `browser.fetch ${method}`,
          traceId,
          spanId,
          parentSpanId: incoming?.parentSpanId,
          startUnixNano: startedNs,
          endUnixNano: nowUnixNano(),
          statusCode: 500,
          statusMessage: String(err),
          attrs: {
            "http.method": method,
            "http.url": requestUrl,
            "http.duration_ms": duration,
          },
        });
        captureReplayEvent("network_error", {
          method,
          url: requestUrl,
          dur_ms: duration,
          error: String(err),
        });
        throw err;
      }
    };
  };

  const shutdown = async () => {
    clearInterval(replayTimer);
    try { flushReplay(); } catch {}
    for (const c of cleanups) {
      try { c(); } catch {}
    }

    instances.delete(entry);
    replayBuffers.delete(replay);

    if (instances.size === 0) {
      teardownSharedConsoleCapture();
      teardownSharedNavigationTracker();
      teardownSharedRrwebRecording();
    }

    await client.shutdown();
  };

  const sdk: BrowserSDK = {
    client,
    sessionId: replay.sessionId,
    log,
    metric: client.metric.bind(client),
    captureException,
    captureError: captureException,
    captureReplayEvent,
    flushReplay,
    captureRecipe,
    instrumentFetch,
    shutdown,
  };

  if (config.instrumentGlobalFetch !== false && typeof window !== "undefined") {
    window.fetch = instrumentFetch();
  }

  return sdk;
}
