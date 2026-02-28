import { createApp, h } from "vue";
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

const App = {
  render() {
    return h("div", [
      h("h1", "Vue + Vite + Obtrace"),
      h(
        "button",
        {
          onClick: () => sdk.log("info", "vue button clicked")
        },
        "Emit event"
      )
    ]);
  }
};

createApp(App).mount("#app");
