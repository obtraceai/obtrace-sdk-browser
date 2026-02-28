import type { ObtraceSDKConfig } from "../../shared/types";
import { initBrowserSDK } from "../../browser/index";

export function createVueObtrace(config: ObtraceSDKConfig) {
  return initBrowserSDK(config);
}
