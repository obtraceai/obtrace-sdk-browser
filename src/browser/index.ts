import { record } from "rrweb";
import { SpanStatusCode } from "@opentelemetry/api";
import type { Tracer, Meter } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { ObtraceClient } from "../core/client";
import { setupOtelWeb, type OtelHandles } from "../core/otel-web-setup";
import type { ObtraceSDKConfig, ReplayStep, SDKContext } from "../shared/types";
import { installBrowserErrorHooks } from "./errors";
import { BrowserReplayBuffer } from "./replay";
import { installWebVitals } from "./vitals";
import { addBreadcrumb as addCrumb, getBreadcrumbs, installClickBreadcrumbs, type Breadcrumb } from "./breadcrumbs";
import { installConsoleCapture } from "./console";
import { installClickTracking } from "./clicks";
import { installResourceTiming } from "./resources";
import { installLongTaskDetection } from "./longtasks";
import { installMemoryTracking } from "./memory";
import { installOfflineSupport } from "./offline";
import { installSupabaseFetchInterceptor } from "./supabase-intercept";

export type UserContext = { id?: string; email?: string; name?: string; [key: string]: unknown };

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
  setUser: (user: UserContext) => void;
  addBreadcrumb: (crumb: Breadcrumb) => void;
}

interface InstanceEntry {
  client: ObtraceClient;
  sessionId: string;
  replay: BrowserReplayBuffer;
  config: ObtraceSDKConfig;
  recipeSteps: ReplayStep[];
  otel: OtelHandles;
  sdk?: BrowserSDK;
}

const instances = new Set<InstanceEntry>();
const replayBuffers = new Set<BrowserReplayBuffer>();

let currentUser: UserContext | null = null;

let navigationPatched = false;
let originalPushState: History["pushState"] | null = null;
let originalReplaceState: History["replaceState"] | null = null;
let navigationPopstateHandler: (() => void) | null = null;
let navigationHashchangeHandler: (() => void) | null = null;

let rrwebRecording = false;
let stopRrwebRecording: (() => void) | null = null;

function fanOutNavigation(): void {
  addCrumb({ timestamp: Date.now(), category: "navigation", message: window.location.href, level: "info" });
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
  if (navigationPatched || typeof window === "undefined") return;
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
  if (!navigationPatched || typeof window === "undefined") return;
  if (originalPushState) window.history.pushState = originalPushState;
  if (originalReplaceState) window.history.replaceState = originalReplaceState;
  if (navigationPopstateHandler) window.removeEventListener("popstate", navigationPopstateHandler);
  if (navigationHashchangeHandler) window.removeEventListener("hashchange", navigationHashchangeHandler);
  originalPushState = null;
  originalReplaceState = null;
  navigationPopstateHandler = null;
  navigationHashchangeHandler = null;
  navigationPatched = false;
}

function installSharedRrwebRecording(config: ObtraceSDKConfig): void {
  if (rrwebRecording || typeof window === "undefined") return;
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
    maskInputOptions: { password: true, email: true, tel: true },
    maskInputFn: (text, element) => {
      const el = element as HTMLInputElement;
      const n = (el?.name || "").toLowerCase();
      const id = (el?.id || "").toLowerCase();
      if (/(pass|token|secret|key|email|cpf|ssn|credit|card)/.test(`${n} ${id}`)) return "[redacted]";
      return text;
    },
    blockClass: replayCfg.blockClass ?? "ob-block",
    maskTextClass: replayCfg.maskTextClass ?? "ob-mask",
    inlineStylesheet: true,
    collectFonts: false,
    sampling: {
      mousemove: replayCfg.sampling?.mousemove ?? false,
      mouseInteraction: true,
      scroll: replayCfg.sampling?.scroll ?? 150,
      input: replayCfg.sampling?.input ?? "last",
    },
  });

  if (stop) stopRrwebRecording = stop;
}

function teardownSharedRrwebRecording(): void {
  if (!rrwebRecording) return;
  if (stopRrwebRecording) { stopRrwebRecording(); stopRrwebRecording = null; }
  rrwebRecording = false;
}

function severityToNumber(level: string): number {
  switch (level) {
    case "debug": return 5;
    case "info": return 9;
    case "warn": return 13;
    case "error": return 17;
    case "fatal": return 21;
    default: return 9;
  }
}

function userAttrs(): Record<string, string> {
  if (!currentUser) return {};
  const attrs: Record<string, string> = {};
  if (currentUser.id) attrs["user.id"] = String(currentUser.id);
  if (currentUser.email) attrs["user.email"] = String(currentUser.email);
  if (currentUser.name) attrs["user.name"] = String(currentUser.name);
  return attrs;
}

export function initBrowserSDK(config: ObtraceSDKConfig): BrowserSDK {
  config.ingestBaseUrl = config.ingestBaseUrl || "https://ingest.obtrace.ai";

  for (const entry of instances) {
    if (entry.config.apiKey === config.apiKey && entry.config.ingestBaseUrl === config.ingestBaseUrl && entry.config.serviceName === config.serviceName) {
      return entry.sdk!;
    }
  }

  const sampleRate = config.tracesSampleRate ?? 1;
  const replaySampleRate = config.replaySampleRate ?? 1;
  const shouldReplay = Math.random() < replaySampleRate;

  const replay = new BrowserReplayBuffer({
    maxChunkBytes: config.replay?.maxChunkBytes ?? 480_000,
    flushIntervalMs: config.replay?.flushIntervalMs ?? 5000,
    sessionStorageKey: config.replay?.sessionStorageKey ?? "obtrace_session_id",
  });

  const otel = setupOtelWeb({ ...config, tracesSampleRate: sampleRate, sessionId: replay.sessionId });
  const tracer = otel.tracer;
  const meter = otel.meter;
  const logger = otel.loggerProvider.getLogger("@obtrace/sdk-browser", "2.4.0");

  const client = new ObtraceClient({
    ...config,
    replay: {
      enabled: shouldReplay,
      flushIntervalMs: 5000,
      maxChunkBytes: 480_000,
      captureNetworkRecipes: true,
      sessionStorageKey: "obtrace_session_id",
      ...config.replay,
    },
    vitals: { enabled: true, reportAllChanges: false, ...config.vitals },
    propagation: { enabled: true, ...config.propagation },
  });

  const recipeSteps: ReplayStep[] = [];
  const cleanups: Array<() => void> = [];

  const entry: InstanceEntry = { client, sessionId: replay.sessionId, replay, config, recipeSteps, otel };
  instances.add(entry);
  replayBuffers.add(replay);

  const base = config.ingestBaseUrl?.replace(/\/$/, "") ?? "";
  fetch(`${base}/v1/init`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      sdk: "@obtrace/browser",
      sdk_version: "2.0.0",
      service_name: config.serviceName,
      service_version: config.serviceVersion ?? "",
      runtime: "browser",
      runtime_version: typeof navigator !== "undefined" ? navigator.userAgent : "",
    }),
    signal: AbortSignal.timeout(5000),
  }).then((res) => {
    if (res.ok && config.debug) console.log("[obtrace-sdk-browser] init handshake OK");
    if (!res.ok) console.error(`[obtrace-sdk-browser] init handshake failed: ${res.status}`);
  }).catch(() => {});

  if (config.vitals?.enabled !== false) cleanups.push(installWebVitals(meter, !!config.vitals?.reportAllChanges));
  cleanups.push(installBrowserErrorHooks(tracer, logger, replay.sessionId));
  cleanups.push(installClickBreadcrumbs());
  cleanups.push(installClickTracking(tracer, replay.sessionId));
  cleanups.push(installResourceTiming(meter));
  cleanups.push(installLongTaskDetection(tracer));
  cleanups.push(installMemoryTracking(meter));
  cleanups.push(installSupabaseFetchInterceptor(tracer, replay.sessionId));

  if (config.captureConsole !== false) {
    cleanups.push(installConsoleCapture(tracer, logger, replay.sessionId));
  }

  cleanups.push(installOfflineSupport());

  if (shouldReplay && config.replay?.enabled !== false && typeof window !== "undefined") {
    installSharedRrwebRecording(config);
    installSharedNavigationTracker();
  }

  let pendingBeaconBlob: Blob | null = null;

  client.replayTimer = setInterval(() => {
    const chunk = replay.flush();
    if (chunk) {
      const json = JSON.stringify(chunk);
      pendingBeaconBlob = new Blob([json], { type: "application/json" });
      client.replayChunk(chunk);
    } else {
      pendingBeaconBlob = null;
    }
  }, config.replay?.flushIntervalMs ?? 5000);

  const sendViaBeacon = () => {
    const url = `${config.ingestBaseUrl?.replace(/\/$/, "")}/ingest/replay/chunk?token=${encodeURIComponent(config.apiKey)}`;
    const freshChunk = replay.flush();
    if (freshChunk) {
      navigator.sendBeacon(url, new Blob([JSON.stringify(freshChunk)], { type: "application/json" }));
      pendingBeaconBlob = null;
    } else if (pendingBeaconBlob) {
      navigator.sendBeacon(url, pendingBeaconBlob);
      pendingBeaconBlob = null;
    }
  };

  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      otel.forceFlush();
      flushReplay();
    }
  };
  const onBeforeUnload = () => {
    otel.forceFlush();
    sendViaBeacon();
  };

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
    cleanups.push(() => document.removeEventListener("visibilitychange", onVisibility));
  }
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", onBeforeUnload);
    cleanups.push(() => window.removeEventListener("beforeunload", onBeforeUnload));
  }

  const sevToOtel: Record<string, SeverityNumber> = {
    debug: SeverityNumber.DEBUG,
    info: SeverityNumber.INFO,
    warn: SeverityNumber.WARN,
    error: SeverityNumber.ERROR,
    fatal: SeverityNumber.FATAL,
  };

  const log = (level: "debug" | "info" | "warn" | "error" | "fatal", message: string, context?: SDKContext) => {
    addCrumb({ timestamp: Date.now(), category: "log", message, level: level === "fatal" ? "error" : level });

    logger.emit({
      severityNumber: sevToOtel[level] ?? SeverityNumber.INFO,
      severityText: level.toUpperCase(),
      body: message.slice(0, 4096),
      attributes: {
        "session.id": replay.sessionId,
        "log.source": "sdk",
        ...userAttrs(),
        ...(context?.traceId ? { "obtrace.trace_id": context.traceId } : {}),
        ...context?.attrs,
      },
    });

    if (level === "error" || level === "fatal") {
      const span = tracer.startSpan("browser.error", {
        attributes: {
          "error.message": message,
          "session.id": replay.sessionId,
          ...userAttrs(),
          ...(context?.traceId ? { "obtrace.trace_id": context.traceId } : {}),
          ...context?.attrs,
        },
      });
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      span.end();
    }
  };

  const metricFn = (name: string, value: number, unit?: string, context?: SDKContext) => {
    const gauge = meter.createGauge(name, { unit: unit ?? "1" });
    gauge.record(value, { ...userAttrs(), ...context?.attrs } as Record<string, string | number> | undefined);
  };

  const captureException = (error: unknown, context?: SDKContext) => {
    const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const stack = error instanceof Error ? (error.stack || "").slice(0, 4096) : "";
    const breadcrumbs = getBreadcrumbs();
    addCrumb({ timestamp: Date.now(), category: "error", message: msg, level: "error" });

    logger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: "ERROR",
      body: msg,
      attributes: {
        "session.id": replay.sessionId,
        "log.source": "exception",
        "error.stack": stack,
        "error.type": error instanceof Error ? error.name : "Error",
        ...userAttrs(),
        ...context?.attrs,
      },
    });

    const span = tracer.startSpan("browser.exception", {
      attributes: {
        "error.message": msg,
        "error.stack": stack,
        "session.id": replay.sessionId,
        "breadcrumbs.count": breadcrumbs.length,
        "breadcrumbs.json": JSON.stringify(breadcrumbs.slice(-20)),
        ...userAttrs(),
        ...context?.attrs,
      },
    });
    span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
    if (error instanceof Error) span.recordException(error);
    span.end();
  };

  const captureReplayEvent = (type: string, payload: Record<string, unknown>) => {
    const chunk = replay.pushCustomEvent(type, payload);
    if (chunk) client.replayChunk(chunk);
  };

  const flushReplay = () => {
    const chunk = replay.flush();
    if (chunk) client.replayChunk(chunk);
    if (recipeSteps.length) client.replayRecipes(recipeSteps.splice(0, recipeSteps.length));
  };

  const captureRecipe = (step: ReplayStep) => {
    recipeSteps.push(step);
    if (recipeSteps.length >= 50) client.replayRecipes(recipeSteps.splice(0, recipeSteps.length));
  };

  const instrumentFetch = () => (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => fetch(input, init);

  const setUser = (user: UserContext) => {
    currentUser = user;
    addCrumb({ timestamp: Date.now(), category: "auth", message: `setUser: ${user.id || user.email || "anonymous"}`, level: "info" });
  };

  const shutdown = async () => {
    if (client.replayTimer) { clearInterval(client.replayTimer); client.replayTimer = null; }
    await otel.shutdown();
    try { flushReplay(); } catch {}
    for (const c of cleanups) { try { c(); } catch {} }
    instances.delete(entry);
    replayBuffers.delete(replay);
    if (instances.size === 0) { teardownSharedNavigationTracker(); teardownSharedRrwebRecording(); }
    await client.shutdown();
  };

  const sdk: BrowserSDK = {
    client, sessionId: replay.sessionId, log, metric: metricFn,
    captureException, captureError: captureException,
    captureReplayEvent, flushReplay, captureRecipe, instrumentFetch,
    shutdown, setUser, addBreadcrumb: addCrumb,
  };

  entry.sdk = sdk;
  return sdk;
}
