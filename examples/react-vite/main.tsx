import React from "react";
import { createRoot } from "react-dom/client";
import { initViteBrowserSDK, createViteConfigFromImportMetaEnv } from "../../src/wrappers/frontend/vite";

const sdk = initViteBrowserSDK(
  createViteConfigFromImportMetaEnv(import.meta.env, {
    replay: { enabled: true, captureNetworkRecipes: true },
    vitals: { enabled: true },
    propagation: { enabled: true }
  })
);

const obFetch = sdk.instrumentFetch();
void obFetch("https://httpbin.org/get");

function App() {
  return (
    <div>
      <h1>React + Vite + Obtrace</h1>
      <button
        onClick={() => {
          sdk.log("info", "react button clicked");
        }}
      >
        Emit event
      </button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
