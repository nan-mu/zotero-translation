import { config } from "../package.json";
import {
  DEFAULT_BASE_URL,
  DEFAULT_SCAN_INTERVAL_SECONDS,
} from "./constants";

function prefKey(key: string): string {
  return `${config.prefsPrefix}.${key}`;
}

export class Settings {
  getBaseUrl(): string {
    const value = Zotero.Prefs.get(prefKey("baseUrl"), true) as
      | string
      | undefined;
    return (value && String(value).trim()) || DEFAULT_BASE_URL;
  }

  getToken(): string {
    const value = Zotero.Prefs.get(prefKey("token"), true) as
      | string
      | undefined;
    return value ? String(value) : "";
  }

  getScanIntervalSeconds(): number {
    const value = Zotero.Prefs.get(prefKey("scanIntervalSeconds"), true) as
      | number
      | undefined;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 10) {
      return DEFAULT_SCAN_INTERVAL_SECONDS;
    }
    return Math.min(3600, Math.floor(n));
  }

  isPausedForAuth(): boolean {
    return Boolean(Zotero.Prefs.get(prefKey("pausedForAuth"), true));
  }

  setPausedForAuth(paused: boolean): void {
    Zotero.Prefs.set(prefKey("pausedForAuth"), paused, true);
  }

  getLastScanSummary(): string {
    return String(Zotero.Prefs.get(prefKey("lastScanSummary"), true) || "");
  }

  setLastScanSummary(summary: string): void {
    Zotero.Prefs.set(prefKey("lastScanSummary"), summary, true);
  }

  /**
   * Reject sending Token over plain HTTP except loopback / RFC1918 LAN.
   * Public hosts still require HTTPS.
   */
  assertSafeEndpoint(baseUrl: string): void {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error(`Invalid base URL: ${baseUrl}`);
    }
    if (url.protocol === "https:") {
      return;
    }
    if (url.protocol !== "http:") {
      throw new Error(`Unsupported URL protocol: ${url.protocol}`);
    }
    const host = url.hostname.toLowerCase();
    if (isLoopbackHost(host) || isPrivateLanHost(host)) {
      return;
    }
    throw new Error(
      "Non-private hosts require HTTPS; refusing to send Token over HTTP.",
    );
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** Best-effort IPv4 private ranges (10/8, 172.16/12, 192.168/16). */
function isPrivateLanHost(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) {
    return false;
  }
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  const d = Number(m[4]);
  if ([a, b, c, d].some((n) => n > 255)) {
    return false;
  }
  if (a === 10) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  return false;
}

export const settings = new Settings();
