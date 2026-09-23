import { refreshNavLinks } from "./custom-apps.js";
import { waitFor } from "./shared/async.js";
import { exposeReactComponentsUI } from "./webpack/component-resolvers.js";
import { waitForLateComponents } from "./webpack/late-components.js";
import { getModuleInventory, groupBy } from "./webpack/module-inventory.js";
import { exposeRuntimeResolvers } from "./webpack/runtime-resolvers.js";
import { createScrollableContainer } from "./webpack/scrollable-container.js";
import { createSpicetifyBindings } from "./webpack/spicetify-bindings.js";
import { waitForURI } from "./webpack/uri.js";

// Chunk files can create the queue as a plain array before the loader takes over push();
// pushing into that returns a length instead of require, and init then waits forever.
const getChunkQueue = () => {
  const queue = window?.rspackChunk || window?.rspackChunkclient_web || window?.webpackChunkclient_web;
  return queue && queue.push !== Array.prototype.push ? queue : undefined;
};

// Looking React up once left Spicetify.React undefined whenever Spotify's React module was not
// loaded yet, and Spotify then crashed rendering Spicetify UI or custom apps. Resolve it on demand
// from React's own module instead (require is cached per id, so this is the same instance Spotify
// renders with), rescanning only when new modules have been registered.
(function exposeLazyReact() {
  let react;
  let webpackRequire;
  let scannedCount = 0;
  Object.defineProperty(Spicetify, "React", {
    configurable: true,
    enumerable: true,
    get() {
      if (react) return react;
      const queue = getChunkQueue();
      if (!queue) return undefined;
      webpackRequire ??= queue.push([[Symbol()], {}, (re) => re]);
      if (!webpackRequire?.m) return undefined;
      const ids = Object.keys(webpackRequire.m);
      if (ids.length === scannedCount) return undefined;
      scannedCount = ids.length;
      const id = ids.find((moduleId) => {
        const source = Function.prototype.toString.call(webpackRequire.m[moduleId]);
        return source.includes("react.element") && source.includes(".useMemo=function") && source.includes(".useReducer=function");
      });
      if (id) react = webpackRequire(id);
      return react;
    },
    set(value) {
      if (value) react = value;
    },
  });
})();

void (async function hotloadWebpackModules() {
  const chunkQueue = await waitFor(getChunkQueue, 50);

  // Force all webpack modules to load
  const require = chunkQueue.push([[Symbol()], {}, (re) => re]);
  await waitFor(() => require.m, 50);
  console.log("[spicetifyWrapper] Waiting for required webpack modules to load");
  let webpackDidCallback = false;
  // https://github.com/webpack/webpack/blob/main/lib/runtime/OnChunksLoadedRuntimeModule.js
  require.O(
    null,
    [],
    () => {
      webpackDidCallback = true;
    },
    1,
  );

  let inventory = getModuleInventory(require);
  let chunks = inventory.chunks;
  let cache = inventory.cache;

  // For _renderNavLinks to work
  Spicetify.React = cache.find((m) => m?.useMemo);

  await waitFor(() => webpackDidCallback, 100);
  console.log("[spicetifyWrapper] All required webpack modules loaded");
  inventory = getModuleInventory(require);
  chunks = inventory.chunks;
  cache = inventory.cache;
  Spicetify.Events.platformLoaded.fire();

  const { modules, functionModules } = inventory;
  const exportedReactObjects = groupBy(modules.filter(Boolean), (x) => x.$$typeof);
  const exportedMemos = exportedReactObjects[Symbol.for("react.memo")] ?? [];
  const exportedForwardRefs = exportedReactObjects[Symbol.for("react.forward_ref")] ?? [];
  const exportedMemoFRefs = exportedMemos.filter((m) => m.type.$$typeof === Symbol.for("react.forward_ref"));
  const reactComponentsUI = exposeReactComponentsUI({ modules, functionModules, exportedForwardRefs, exportedMemoFRefs });

  Object.assign(
    Spicetify,
    createSpicetifyBindings({
      cache,
      chunks,
      modules,
      functionModules,
      require,
      exportedMemos,
      exportedMemoFRefs,
      reactComponentsUI,
      scrollableContainer: createScrollableContainer(),
    }),
  );

  if (!Spicetify.ContextMenuV2._context) Spicetify.ContextMenuV2._context = Spicetify.React.createContext({});

  waitForLateComponents({ require, refreshNavLinks });

  exposeRuntimeResolvers({ cache, chunks, modules, functionModules, require });

  waitForURI({ cache, modules, functionModules });

  Spicetify.Events.webpackLoaded.fire();
  refreshNavLinks?.();
})();
