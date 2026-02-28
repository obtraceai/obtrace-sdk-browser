import { initBrowserSDK } from "../../browser/index";
import type { ObtraceSDKConfig } from "../../shared/types";

export function initViteBrowserSDK(config: ObtraceSDKConfig) {
  return initBrowserSDK(config);
}

export function createViteConfigFromImportMetaEnv(
  env: Record<string, string | undefined>,
  base: Omit<ObtraceSDKConfig, "apiKey" | "ingestBaseUrl" | "serviceName"> & { serviceName?: string }
): ObtraceSDKConfig {
  const apiKey = env.VITE_OBTRACE_API_KEY ?? "";
  const ingestBaseUrl = env.VITE_OBTRACE_INGEST_BASE_URL ?? "";
  const serviceName = base.serviceName ?? env.VITE_OBTRACE_SERVICE_NAME ?? "vite-app";

  return {
    ...base,
    apiKey,
    ingestBaseUrl,
    serviceName,
    tenantId: base.tenantId ?? env.VITE_OBTRACE_TENANT_ID,
    projectId: base.projectId ?? env.VITE_OBTRACE_PROJECT_ID,
    appId: base.appId ?? env.VITE_OBTRACE_APP_ID,
    env: base.env ?? env.MODE ?? env.VITE_OBTRACE_ENV ?? "dev"
  };
}
