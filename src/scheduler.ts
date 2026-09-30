import { NOTIFIER_DEBOUNCE_MS } from "./constants";
import { diagnostics } from "./diagnostics";
import { scanner } from "./scanner";
import { settings } from "./settings";

export class Scheduler {
  private running = false;
  private rescanRequested = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private notifierID: string | null = null;
  private stopped = false;

  async start(): Promise<void> {
    this.stopped = false;
    this.registerNotifier();
    this.resetInterval();
    await this.requestScan("startup");
  }

  stop(): void {
    this.stopped = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.notifierID) {
      Zotero.Notifier.unregisterObserver(this.notifierID);
      this.notifierID = null;
    }
  }

  resetInterval(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
    }
    const seconds = settings.getScanIntervalSeconds();
    this.intervalTimer = setInterval(() => {
      void this.requestScan("interval");
    }, seconds * 1000);
  }

  async requestScan(reason: string): Promise<void> {
    if (this.stopped) {
      return;
    }
    if (this.running) {
      this.rescanRequested = true;
      diagnostics.info(`Scan busy; queued rescan (${reason})`);
      return;
    }
    this.running = true;
    try {
      do {
        this.rescanRequested = false;
        diagnostics.info(`Scan start (${reason})`);
        const summary = await scanner.run();
        diagnostics.info(
          `Scan done scanned=${summary.scanned} imported=${summary.imported} errors=${summary.errors.length}`,
        );
        reason = "rescan";
      } while (this.rescanRequested && !this.stopped);
    } catch (e) {
      diagnostics.error(`Scan crashed: ${String(e)}`);
    } finally {
      this.running = false;
    }
  }

  private registerNotifier(): void {
    const callback = {
      notify: (
        event: string,
        type: string,
        ids: string[] | number[],
        _extraData: Record<string, unknown>,
      ) => {
        if (this.stopped) {
          return;
        }
        if (type !== "item" && type !== "item-tag") {
          return;
        }
        // Ignore pure refresh noise; still debounce any item/tag change
        if (
          event !== "add" &&
          event !== "modify" &&
          event !== "delete" &&
          event !== "trash" &&
          event !== "refresh"
        ) {
          // item-tag uses add/remove
          if (type === "item-tag" && (event === "add" || event === "remove")) {
            this.scheduleDebouncedScan();
          }
          return;
        }
        void ids;
        this.scheduleDebouncedScan();
      },
    };
    this.notifierID = Zotero.Notifier.registerObserver(callback, [
      "item",
      "item-tag",
    ], "zotero-translation");
  }

  private scheduleDebouncedScan(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.requestScan("notifier");
    }, NOTIFIER_DEBOUNCE_MS);
  }
}

export const scheduler = new Scheduler();
