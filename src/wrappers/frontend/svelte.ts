import type { ObtraceSDKConfig } from "../../shared/types";
import { initBrowserSDK } from "../../browser/index";

export function createSvelteObtrace(config: ObtraceSDKConfig) {
  return initBrowserSDK(config);
}
