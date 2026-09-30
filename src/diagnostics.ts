type Level = "info" | "warn" | "error";

export interface LogEntry {
  time: string;
  level: Level;
  message: string;
}

const MAX_ENTRIES = 200;
const ring: LogEntry[] = [];

function redact(message: string): string {
  return message
    .replace(/Bearer\s+[^\s]+/gi, "Bearer ***")
    .replace(/token[=:]\s*[^\s,;]+/gi, "token=***");
}

function push(level: Level, message: string): void {
  const entry: LogEntry = {
    time: new Date().toISOString(),
    level,
    message: redact(message),
  };
  ring.push(entry);
  if (ring.length > MAX_ENTRIES) {
    ring.shift();
  }
  Zotero.debug(`[ZoteroTranslation][${level}] ${entry.message}`);
}

export const diagnostics = {
  info(message: string): void {
    push("info", message);
  },
  warn(message: string): void {
    push("warn", message);
  },
  error(message: string): void {
    push("error", message);
  },
  recent(limit = 40): LogEntry[] {
    return ring.slice(-limit);
  },
  formatRecent(limit = 40): string {
    return this.recent(limit)
      .map((e) => `${e.time} [${e.level}] ${e.message}`)
      .join("\n");
  },
  shortHash(hash: string): string {
    return hash.slice(0, 12);
  },
};
