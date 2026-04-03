# Getting Started

## Install

```bash
npm install @obtrace/sdk-browser
# or
bun add @obtrace/sdk-browser
```

## Minimal Browser setup

`serviceName` is not free-form. Use the connected app name from the project, or an explicit alias configured for that app.

```ts
import { initBrowserSDK } from "@obtrace/sdk-browser/browser";

const sdk = initBrowserSDK({
  apiKey: "<API_KEY>",
  serviceName: "core",
  tenantId: "tenant-prod",
  projectId: "project-prod",
  appId: "core",
  env: "prod"
});
```

Example: if the project app is `core` and the project defines alias `web`, `serviceName: "web"` is accepted and normalized to `core` on ingest.

## Vite setup helper

```ts
import { createViteConfigFromImportMetaEnv, initViteBrowserSDK } from "@obtrace/sdk-browser";

const cfg = createViteConfigFromImportMetaEnv(import.meta.env, {
  tenantId: "tenant-prod",
  projectId: "project-prod",
  appId: "core"
});

const sdk = initViteBrowserSDK(cfg);
```
