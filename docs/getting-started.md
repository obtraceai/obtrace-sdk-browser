# Getting Started

## Install

```bash
npm install @obtrace/sdk-browser
# or
bun add @obtrace/sdk-browser
```

## Minimal Browser setup

```ts
import { initBrowserSDK } from "@obtrace/sdk-browser/browser";

const sdk = initBrowserSDK({
  apiKey: "<API_KEY>",
  ingestBaseUrl: "https://inject.obtrace.ai",
  serviceName: "web-app",
  tenantId: "tenant-prod",
  projectId: "project-prod",
  appId: "web",
  env: "prod"
});
```

## Vite setup helper

```ts
import { createViteConfigFromImportMetaEnv, initViteBrowserSDK } from "@obtrace/sdk-browser";

const cfg = createViteConfigFromImportMetaEnv(import.meta.env, {
  tenantId: "tenant-prod",
  projectId: "project-prod",
  appId: "web"
});

const sdk = initViteBrowserSDK(cfg);
```

## Minimal Node/Bun setup

```ts
import { initNodeSDK } from "@obtrace/sdk-browser/node";

const sdk = initNodeSDK({
  apiKey: process.env.OBTRACE_API_KEY!,
  ingestBaseUrl: process.env.OBTRACE_INGEST_BASE_URL!,
  serviceName: "api-service",
  env: "prod"
});
```
