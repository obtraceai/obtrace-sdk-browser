import type { ObtraceSDKConfig } from "../../shared/types";
import { initBrowserSDK } from "../../browser/index";

export function initNextBrowserSDK(config: ObtraceSDKConfig) {
  return initBrowserSDK(config);
}

export function withNextFetchInstrumentation(fetchImpl: typeof fetch, _sdk: ReturnType<typeof initBrowserSDK>): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof window !== "undefined") {
      return fetch(input, init);
    }
    return fetchImpl(input, init);
  };
}
