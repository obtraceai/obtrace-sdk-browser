import { initBrowserSDK, type BrowserSDK } from "./browser/index";

let _sdk: BrowserSDK | null = null;

function resolveEnv(key: string): string | undefined {
  if (typeof globalThis !== "undefined" && "process" in globalThis) {
    const val = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env[key];
    if (val) return val;
  }
  if (typeof (globalThis as unknown as Record<string, unknown>).__OBTRACE_CONFIG__ === "object") {
    const cfg = (globalThis as unknown as { __OBTRACE_CONFIG__: Record<string, string> }).__OBTRACE_CONFIG__;
    if (cfg[key]) return cfg[key];
  }
  return undefined;
}

function detectConfig() {
  const prefixes = ["VITE_", "NEXT_PUBLIC_", "REACT_APP_", ""];
  let apiKey = "";
  let ingestBaseUrl = "";
  let serviceName = "";

  for (const p of prefixes) {
    apiKey = apiKey || resolveEnv(`${p}OBTRACE_API_KEY`) || "";
    ingestBaseUrl = ingestBaseUrl || resolveEnv(`${p}OBTRACE_INGEST_BASE_URL`) || "";
    serviceName = serviceName || resolveEnv(`${p}OBTRACE_SERVICE_NAME`) || "";
  }

  if (!apiKey || !ingestBaseUrl) return null;

  return {
    apiKey,
    ingestBaseUrl,
    serviceName: serviceName || "web-app",
    appId: resolveEnv("VITE_OBTRACE_APP_ID") || resolveEnv("NEXT_PUBLIC_OBTRACE_APP_ID") || resolveEnv("REACT_APP_OBTRACE_APP_ID"),
    env: resolveEnv("VITE_OBTRACE_ENV") || resolveEnv("NEXT_PUBLIC_OBTRACE_ENV") || resolveEnv("REACT_APP_OBTRACE_ENV") || resolveEnv("NODE_ENV") || "production",
  };
}

function autoInit() {
  if (typeof window === "undefined") return;
  if (_sdk) return;

  const config = detectConfig();
  if (!config) return;

  const originalFetch = window.fetch.bind(window);
  _sdk = initBrowserSDK(config);
  void originalFetch;
  window.fetch = _sdk.instrumentFetch();
}

autoInit();

export function getObtrace(): BrowserSDK | null {
  return _sdk;
}
