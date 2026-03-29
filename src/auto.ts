import { initBrowserSDK, type BrowserSDK } from "./browser/index";

declare global {
  interface Window {
    __OBTRACE_CONFIG__?: {
      apiKey?: string;
      ingestBaseUrl?: string;
      serviceName?: string;
      appId?: string;
      env?: string;
    };
  }
}

let _sdk: BrowserSDK | null = null;
let _observer: MutationObserver | null = null;

interface AutoConfig {
  apiKey: string;
  ingestBaseUrl?: string;
  serviceName: string;
  appId?: string;
  env?: string;
}

function readWindowConfig(): Partial<AutoConfig> {
  if (typeof window !== "undefined" && window.__OBTRACE_CONFIG__) {
    const cfg = window.__OBTRACE_CONFIG__;
    return {
      apiKey: cfg.apiKey,
      ingestBaseUrl: cfg.ingestBaseUrl,
      serviceName: cfg.serviceName,
      appId: cfg.appId,
      env: cfg.env,
    };
  }
  return {};
}

function readMetaTag(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  const el = document.querySelector(`meta[name="${name}"]`);
  return el?.getAttribute("content") || undefined;
}

function readMetaConfig(): Partial<AutoConfig> {
  return {
    apiKey: readMetaTag("obtrace-api-key"),
    ingestBaseUrl: readMetaTag("obtrace-ingest-url"),
    serviceName: readMetaTag("obtrace-service-name"),
    appId: readMetaTag("obtrace-app-id"),
    env: readMetaTag("obtrace-env"),
  };
}

function resolveEnvVar(key: string): string | undefined {
  if (typeof globalThis !== "undefined" && "process" in globalThis) {
    const val = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env[key];
    if (val) return val;
  }
  return undefined;
}

function readEnvConfig(): Partial<AutoConfig> {
  const prefixes = ["VITE_", "NEXT_PUBLIC_", "REACT_APP_", ""];
  let apiKey: string | undefined;
  let ingestBaseUrl: string | undefined;
  let serviceName: string | undefined;
  let appId: string | undefined;
  let env: string | undefined;

  for (const p of prefixes) {
    apiKey = apiKey || resolveEnvVar(`${p}OBTRACE_API_KEY`);
    ingestBaseUrl = ingestBaseUrl || resolveEnvVar(`${p}OBTRACE_INGEST_BASE_URL`);
    serviceName = serviceName || resolveEnvVar(`${p}OBTRACE_SERVICE_NAME`);
    appId = appId || resolveEnvVar(`${p}OBTRACE_APP_ID`);
    env = env || resolveEnvVar(`${p}OBTRACE_ENV`);
  }

  env = env || resolveEnvVar("NODE_ENV");

  return { apiKey, ingestBaseUrl, serviceName, appId, env };
}

function merge(...sources: Partial<AutoConfig>[]): AutoConfig | null {
  const merged: Partial<AutoConfig> = {};
  for (const src of sources) {
    for (const k of Object.keys(src) as (keyof AutoConfig)[]) {
      if (!merged[k] && src[k]) {
        (merged as Record<string, string>)[k] = src[k] as string;
      }
    }
  }
  if (!merged.apiKey) return null;
  return {
    apiKey: merged.apiKey,
    ingestBaseUrl: merged.ingestBaseUrl || "https://ingest.obtrace.ai",
    serviceName: merged.serviceName || "web-app",
    appId: merged.appId,
    env: merged.env || "production",
  };
}

function detectConfig(): AutoConfig | null {
  return merge(readWindowConfig(), readMetaConfig(), readEnvConfig());
}

function initFromConfig(config: AutoConfig): void {
  if (_sdk) return;
  _sdk = initBrowserSDK(config);
  teardownObserver();
}

function teardownObserver(): void {
  if (_observer) {
    _observer.disconnect();
    _observer = null;
  }
}

function setupDeferredInit(): void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;

  _observer = new MutationObserver(() => {
    const config = merge(readWindowConfig(), readMetaConfig(), readEnvConfig());
    if (config) {
      initFromConfig(config);
    }
  });

  const head = document.head || document.documentElement;
  _observer.observe(head, { childList: true });

  setTimeout(() => {
    if (!_sdk) {
      teardownObserver();
    }
  }, 5000);
}

function autoInit() {
  if (typeof window === "undefined") return;
  if (_sdk) return;

  const config = detectConfig();
  if (config) {
    initFromConfig(config);
    return;
  }

  console.warn(
    "[obtrace] No configuration found. Provide config via window.__OBTRACE_CONFIG__, " +
    '<meta name="obtrace-api-key">, or build-time env vars (VITE_OBTRACE_API_KEY, etc). ' +
    "Deferring initialization until config appears."
  );

  setupDeferredInit();
}

autoInit();

export function getObtrace(): BrowserSDK | null {
  return _sdk;
}
