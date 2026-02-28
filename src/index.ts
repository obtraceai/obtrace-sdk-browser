export { initBrowserSDK } from "./browser/index";
export type { BrowserSDK } from "./browser/index";

export { initNextBrowserSDK, withNextFetchInstrumentation } from "./wrappers/frontend/next";
export { initViteBrowserSDK, createViteConfigFromImportMetaEnv } from "./wrappers/frontend/vite";
export { createReactObtrace } from "./wrappers/frontend/react";
export { createVueObtrace } from "./wrappers/frontend/vue";
export { createAngularObtrace } from "./wrappers/frontend/angular";
export { createSvelteObtrace } from "./wrappers/frontend/svelte";

export type { ObtraceSDKConfig, SDKContext, ReplayStep } from "./shared/types";
