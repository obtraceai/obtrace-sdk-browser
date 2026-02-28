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
      ...config.replay
    },
    vitals: {
      enabled: true,
      reportAllChanges: false,
      ...config.vitals
    },
    propagation: {
      enabled: true,
      ...config.propagation
    }
  });

  const replay = new BrowserReplayBuffer({
    maxChunkBytes: config.replay?.maxChunkBytes ?? 480_000,
    flushIntervalMs: config.replay?.flushIntervalMs ?? 5000,
    sessionStorageKey: config.replay?.sessionStorageKey ?? "obtrace_session_id"
  });

  const recipeSteps: ReplayStep[] = [];
  const cleanups: Array<() => void> = [];

  if (config.vitals?.enabled !== false) {
    cleanups.push(installWebVitals(client, !!config.vitals?.reportAllChanges));
  }

  cleanups.push(installBrowserErrorHooks(client, replay.sessionId));
  cleanups.push(installConsoleCapture(client, replay.sessionId));
  cleanups.push(installInteractionReplayCapture(replay, client));
  cleanups.push(installDOMRecorder(replay, client));

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
    const chunk = replay.push(type, payload);
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
        sessionId: replay.sessionId
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
          req_body_b64: reqBody ? replay.encodeBody(reqBody) : undefined
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
          attrs: { duration_ms: duration }
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
            "http.duration_ms": duration
          }
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
          attrs: { duration_ms: duration }
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
            "http.duration_ms": duration
          }
        });
        captureReplayEvent("network_error", {
          method,
          url: requestUrl,
          dur_ms: duration,
          error: String(err)
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
    shutdown
  };
}

function installInteractionReplayCapture(replay: BrowserReplayBuffer, client: ObtraceClient): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => undefined;
  }

  const click = (ev: MouseEvent) => {
    const target = ev.target as HTMLElement | null;
    const tag = target?.tagName?.toLowerCase() ?? "unknown";
    const id = target?.id || "";
    const cls = target?.className ? String(target.className).slice(0, 64) : "";
    const path = window.location.pathname;

    const chunk = replay.push("ui_click", {
      x: ev.clientX,
      y: ev.clientY,
      tag,
      id,
      cls,
      path
    });
    if (chunk) {
      client.replayChunk(chunk);
    }
  };

  const nav = () => {
    const chunk = replay.push("nav", {
      href: window.location.href,
      title: document.title
    });
    if (chunk) {
      client.replayChunk(chunk);
    }
    const snap = replay.captureInitialDOMSnapshot(document);
    if (snap) {
      client.replayChunk(snap);
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

  window.addEventListener("click", click, { passive: true });
  window.addEventListener("popstate", nav);
  window.addEventListener("hashchange", nav);

  return () => {
    historyRef.pushState = rawPush;
    historyRef.replaceState = rawReplace;
    window.removeEventListener("click", click);
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
    error: console.error.bind(console)
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

function installDOMRecorder(replay: BrowserReplayBuffer, client: ObtraceClient): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => undefined;
  }

  const first = replay.captureInitialDOMSnapshot(document);
  if (first) {
    client.replayChunk(first);
  }

  const mutationObs = new MutationObserver((records) => {
    for (const r of records) {
      const targetPath = nodePath(r.target);
      if (r.type === "childList") {
        const addedHTML = [...r.addedNodes]
          .slice(0, 5)
          .map((n) => (n instanceof Element ? n.outerHTML : n.textContent ?? ""));
        const removedPaths = [...r.removedNodes].slice(0, 5).map((n) => nodePath(n));
        const chunk = replay.captureDOMMutation({
          kind: "childList",
          targetPath,
          addedHTML,
          removedPaths
        });
        if (chunk) {
          client.replayChunk(chunk);
        }
      } else if (r.type === "attributes") {
        const attr = r.attributeName ?? "";
        if (attr.toLowerCase().startsWith("on")) {
          continue;
        }
        const value = r.target instanceof Element ? r.target.getAttribute(attr) : null;
        const chunk = replay.captureDOMMutation({
          kind: "attributes",
          targetPath,
          attributeName: attr,
          attributeValue: sanitizeMutationValue(attr, value)
        });
        if (chunk) {
          client.replayChunk(chunk);
        }
      } else if (r.type === "characterData") {
        const chunk = replay.captureDOMMutation({
          kind: "characterData",
          targetPath,
          textContent: sanitizeMutationValue("text", r.target.textContent ?? "")
        });
        if (chunk) {
          client.replayChunk(chunk);
        }
      }
    }
  });

  mutationObs.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
    attributeOldValue: false
  });

  const onInput = (ev: Event) => {
    const target = ev.target as HTMLInputElement | HTMLTextAreaElement | null;
    if (!target) {
      return;
    }
    const type = "type" in target ? target.type : "text";
    const val = shouldMaskInput(target) ? "[redacted]" : target.value;
    const chunk = replay.captureInput({
      targetPath: nodePath(target),
      value: val,
      inputType: type
    });
    if (chunk) {
      client.replayChunk(chunk);
    }
  };

  const onScroll = () => {
    const chunk = replay.captureScroll({
      x: window.scrollX,
      y: window.scrollY,
      path: window.location.pathname
    });
    if (chunk) {
      client.replayChunk(chunk);
    }
  };

  const onResize = () => {
    const chunk = replay.captureViewport({
      w: window.innerWidth,
      h: window.innerHeight
    });
    if (chunk) {
      client.replayChunk(chunk);
    }
  };

  document.addEventListener("input", onInput, true);
  document.addEventListener("change", onInput, true);
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onResize);

  return () => {
    mutationObs.disconnect();
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("change", onInput, true);
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onResize);
  };
}

function nodePath(node: Node): string {
  const segments: string[] = [];
  let current: Node | null = node;
  while (current && current.parentNode) {
    const curr = current;
    if (curr instanceof Element) {
      const tag = curr.tagName.toLowerCase();
      const parent = curr.parentElement;
      if (!parent) {
        segments.unshift(tag);
        break;
      }
      const siblings = [...parent.children].filter((c) => c.tagName === curr.tagName);
      const idx = siblings.indexOf(curr);
      segments.unshift(`${tag}[${idx}]`);
    } else {
      segments.unshift("text");
    }
    current = current.parentNode;
    if (segments.length > 16) {
      break;
    }
  }
  return segments.join("/");
}

function shouldMaskInput(target: HTMLInputElement | HTMLTextAreaElement): boolean {
  if (target instanceof HTMLInputElement) {
    const type = (target.type || "").toLowerCase();
    if (["password", "email", "tel", "number"].includes(type)) {
      return true;
    }
  }
  const n = (target.name || "").toLowerCase();
  const i = (target.id || "").toLowerCase();
  return /(pass|token|secret|key|email|cpf|ssn|credit|card)/.test(`${n} ${i}`);
}

function sanitizeMutationValue(attr: string, value: string | null): string {
  if (!value) {
    return "";
  }
  const a = attr.toLowerCase();
  if (/(value|srcdoc|href|src)/.test(a) && value.length > 256) {
    return `${value.slice(0, 256)}...[truncated]`;
  }
  if (/(token|secret|key|password|authorization|cookie)/.test(a)) {
    return "[redacted]";
  }
  return value;
}
