import { initBrowserSDK } from "../../browser/index";
import type { ObtraceSDKConfig } from "../../shared/types";

export function initViteBrowserSDK(config: ObtraceSDKConfig) {
  return initBrowserSDK(config);
}

export function createViteConfigFromImportMetaEnv(
  env: Record<string, string | undefined>,
  base: Omit<ObtraceSDKConfig, "apiKey" | "serviceName"> & { serviceName?: string }
): ObtraceSDKConfig {
  const apiKey = env.VITE_OBTRACE_PUBLIC_KEY ?? env.VITE_OBTRACE_API_KEY ?? "";

  return {
    ...base,
    apiKey,
    serviceName: base.serviceName ?? "vite-app",
  };
}
