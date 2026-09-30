import { config } from "../package.json";
import { diagnostics } from "./diagnostics";
import { prefsUi } from "./prefs-ui";
import { retrySelectedTranslations } from "./retry-command";
import { scheduler } from "./scheduler";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    src: `chrome://${config.addonRef}/content/preferences/preferences.xhtml`,
    scripts: [],
    label: "Zotero Translation",
  });

  // Expose prefs helpers
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Zotero as any)[config.addonInstance].prefsUi = prefsUi;

  for (const win of Zotero.getMainWindows()) {
    onMainWindowLoad(win);
  }

  await scheduler.start();
  addon.data.initialized = true;
  diagnostics.info("Plugin started");
}

function onMainWindowLoad(win: Window): void {
  // Menu: Retry translation
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = win.document as any;
    const menupopup = doc.getElementById("zotero-itemmenu");
    if (!menupopup) {
      return;
    }
    const id = `${config.addonRef}-retry-menuitem`;
    if (doc.getElementById(id)) {
      return;
    }
    const item = doc.createXULElement
      ? doc.createXULElement("menuitem")
      : doc.createElement("menuitem");
    item.id = id;
    item.setAttribute("label", "重试翻译");
    item.addEventListener("command", () => {
      void retrySelectedTranslations();
    });
    menupopup.appendChild(item);
  } catch (e) {
    diagnostics.warn(`Menu inject failed: ${String(e)}`);
  }
}

function onMainWindowUnload(win: Window): void {
  try {
    const el = win.document.getElementById(
      `${config.addonRef}-retry-menuitem`,
    );
    el?.remove();
  } catch {
    // ignore
  }
}

function onShutdown(): void {
  scheduler.stop();
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (Zotero as any)[config.addonInstance];
  diagnostics.info("Plugin shutdown");
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
};
