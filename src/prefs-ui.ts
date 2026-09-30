import { diagnostics } from "./diagnostics";
import { AuthError, httpClient } from "./http-client";
import { scheduler } from "./scheduler";
import { settings } from "./settings";

export const prefsUi = {
  init(doc: Document): void {
    const el = doc.getElementById("zotero-translation-last-result");
    if (el) {
      el.textContent =
        settings.getLastScanSummary() ||
        "(no scan yet)\n\n" + diagnostics.formatRecent(20);
    }
  },

  async testConnection(): Promise<void> {
    try {
      settings.assertSafeEndpoint(settings.getBaseUrl());
      settings.setPausedForAuth(false);
      const ok = await httpClient.health();
      const msg = ok
        ? `Connection OK @ ${new Date().toISOString()}`
        : "Connection failed";
      settings.setLastScanSummary(msg);
      this.refreshOpenPrefs(msg);
      diagnostics.info(msg);
    } catch (e) {
      if (e instanceof AuthError) {
        settings.setPausedForAuth(true);
      }
      const msg = `Connection error: ${String(e)}`;
      settings.setLastScanSummary(msg);
      this.refreshOpenPrefs(msg);
      diagnostics.error(msg);
    }
  },

  async scanNow(): Promise<void> {
    settings.setPausedForAuth(false);
    scheduler.resetInterval();
    await scheduler.requestScan("manual");
    const msg = settings.getLastScanSummary();
    this.refreshOpenPrefs(msg);
  },

  refreshOpenPrefs(text: string): void {
    try {
      const windows = Zotero.getMainWindows?.() || [];
      for (const win of windows) {
        const doc = win.document;
        const el = doc.getElementById("zotero-translation-last-result");
        if (el) {
          el.textContent = text;
        }
      }
    } catch {
      // prefs window may use different document; ignore
    }
  },
};
