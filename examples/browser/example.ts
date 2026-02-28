import { initBrowserSDK } from "../../src/browser/index";

const sdk = initBrowserSDK({
  apiKey: "devkey",
  ingestBaseUrl: "https://inject.obtrace.ai",
  tenantId: "tenant-dev",
  projectId: "project-dev",
  appId: "web",
  env: "dev",
  serviceName: "example-web",
  replay: { enabled: true, captureNetworkRecipes: true },
  vitals: { enabled: true },
  propagation: { enabled: true },
  debug: true
});

const obFetch = sdk.instrumentFetch();
void obFetch("https://httpbin.org/get");
sdk.log("info", "browser sdk initialized");

window.addEventListener("beforeunload", () => {
  void sdk.shutdown();
});
