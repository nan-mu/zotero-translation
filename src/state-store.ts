import { config } from "../package.json";
import { CleanupEntry } from "./constants";
import { diagnostics } from "./diagnostics";

function prefKey(key: string): string {
  return `${config.prefsPrefix}.${key}`;
}

export class StateStore {
  getCleanupQueue(): CleanupEntry[] {
    try {
      const raw = String(Zotero.Prefs.get(prefKey("cleanupQueue"), true) || "[]");
      const parsed = JSON.parse(raw) as CleanupEntry[];
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter((e) => e && typeof e.hash === "string");
    } catch {
      diagnostics.warn("Failed to parse cleanupQueue; resetting");
      return [];
    }
  }

  setCleanupQueue(entries: CleanupEntry[]): void {
    Zotero.Prefs.set(prefKey("cleanupQueue"), JSON.stringify(entries), true);
  }

  enqueueCleanup(hash: string): void {
    const queue = this.getCleanupQueue();
    if (queue.some((e) => e.hash === hash)) {
      return;
    }
    queue.push({ hash, insertedAt: Date.now() });
    this.setCleanupQueue(queue);
  }

  removeCleanup(hash: string): void {
    this.setCleanupQueue(this.getCleanupQueue().filter((e) => e.hash !== hash));
  }

  async ensureTempDir(): Promise<string> {
    const dir = PathUtils.join(Zotero.DataDirectory.dir, "zotero-translation-tmp");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const IOUtilsAny = (globalThis as any).IOUtils;
    const exists = await IOUtilsAny.exists(dir);
    if (!exists) {
      await IOUtilsAny.makeDirectory(dir, { createAncestors: true });
    }
    return dir;
  }

  async cleanupStaleTempFiles(maxAgeMs = 24 * 60 * 60 * 1000): Promise<void> {
    try {
      const dir = await this.ensureTempDir();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const IOUtilsAny = (globalThis as any).IOUtils;
      const children: string[] = await IOUtilsAny.getChildren(dir);
      const now = Date.now();
      for (const name of children) {
        const path = PathUtils.join(dir, name);
        try {
          const stat = await IOUtilsAny.stat(path);
          if (now - Number(stat.lastModified) > maxAgeMs) {
            await IOUtilsAny.remove(path);
          }
        } catch {
          // ignore
        }
      }
    } catch (e) {
      diagnostics.warn(`Temp cleanup failed: ${String(e)}`);
    }
  }

  dualTempPath(hash: string): string {
    // Fixed local name; never trust Content-Disposition
    return PathUtils.join(
      Zotero.DataDirectory.dir,
      "zotero-translation-tmp",
      `dual-${hash.slice(0, 16)}.pdf`,
    );
  }
}

export const stateStore = new StateStore();
