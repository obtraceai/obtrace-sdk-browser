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
  captureReplayEvent: (type: string, payload: Record<string, unknown>) => void;
  flushReplay: () => void;
  captureRecipe: (step: ReplayStep) => void;
  instrumentFetch: () => (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  shutdown: () => Promise<void>;
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

  if (config.vitals?.enabled !== false) {
    cleanups.push(installWebVitals(client, !!config.vitals?.reportAllChanges));
  }

  cleanups.push(installBrowserErrorHooks(client, replay.sessionId));
  cleanups.push(installConsoleCapture(client, replay.sessionId));

  if (config.replay?.enabled !== false && typeof window !== "undefined") {
    const replayCfg = config.replay ?? { enabled: true };
    const stopRecording = record({
      emit(event) {
        const chunk = replay.pushRrwebEvent(event);
        if (chunk) {
          client.replayChunk(chunk);
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
    if (stopRecording) {
      cleanups.push(stopRecording);
    }

    cleanups.push(installNavigationTracker(replay, client));
  }

  const replayTimer = setInterval(() => {
    const chunk = replay.flush();
    if (chunk) {
      client.replayChunk(chunk);
    }
  }, config.replay?.flushIntervalMs ?? 5000);
  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      flushReplay();
      void client.flush();
    }
  };
  const onBeforeUnload = () => {
    flushReplay();
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
    client.log(level, message, { ...context, sessionId: replay.sessionId });
  };

  const captureException = (error: unknown, context?: SDKContext) => {
    const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    client.log("error", msg, { ...context, sessionId: replay.sessionId });
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
    flushReplay();
    for (const c of cleanups) {
      c();
    }
    await client.shutdown();
  };

  return {
    client,
    sessionId: replay.sessionId,
    log,
    metric: client.metric.bind(client),
    captureException,
    captureReplayEvent,
    flushReplay,
    captureRecipe,
    instrumentFetch,
    shutdown,
  };
}

function installNavigationTracker(replay: BrowserReplayBuffer, client: ObtraceClient): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const nav = () => {
    const chunk = replay.pushCustomEvent("navigation", {
      href: window.location.href,
      title: document.title,
    });
    if (chunk) {
      client.replayChunk(chunk);
    }
  };

  const historyRef = window.history;
  const rawPush = historyRef.pushState.bind(historyRef);
  const rawReplace = historyRef.replaceState.bind(historyRef);
  historyRef.pushState = ((...args: unknown[]) => {
    rawPush(...(args as [data: unknown, unused: string, url?: string | URL | null]));
    nav();
  }) as History["pushState"];
  historyRef.replaceState = ((...args: unknown[]) => {
    rawReplace(...(args as [data: unknown, unused: string, url?: string | URL | null]));
    nav();
  }) as History["replaceState"];

  window.addEventListener("popstate", nav);
  window.addEventListener("hashchange", nav);

  return () => {
    historyRef.pushState = rawPush;
    historyRef.replaceState = rawReplace;
    window.removeEventListener("popstate", nav);
    window.removeEventListener("hashchange", nav);
  };
}

function installConsoleCapture(client: ObtraceClient, sessionId: string): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }
  const orig = {
    debug: console.debug.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  console.debug = (...args: unknown[]) => {
    client.log("debug", args.map(String).join(" "), { sessionId });
    orig.debug(...args);
  };
  console.info = (...args: unknown[]) => {
    client.log("info", args.map(String).join(" "), { sessionId });
    orig.info(...args);
  };
  console.warn = (...args: unknown[]) => {
    client.log("warn", args.map(String).join(" "), { sessionId });
    orig.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    client.log("error", args.map(String).join(" "), { sessionId });
    orig.error(...args);
  };
  return () => {
    console.debug = orig.debug;
    console.info = orig.info;
    console.warn = orig.warn;
    console.error = orig.error;
  };
}
