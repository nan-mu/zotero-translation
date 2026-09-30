export const TAGS = {
  NEED: "急需翻译",
  DONE: "翻译完成",
  MISSING: "缺少PDF",
  FAILED: "翻译失败",
} as const;

export const ATTACHMENT_TITLES = {
  SOURCE: "Full Text PDF",
  DUAL: "翻译对照 PDF",
} as const;

export const DEFAULT_BASE_URL = "http://127.0.0.1:8765";
export const DEFAULT_SCAN_INTERVAL_SECONDS = 60;
export const NOTIFIER_DEBOUNCE_MS = 2000;

export type DocumentStatus = "pending" | "down" | "error";

export interface CleanupEntry {
  hash: string;
  insertedAt: number;
}

export interface GroupMember {
  libraryID: number;
  itemKey: string;
  sourceAttachmentKey: string;
}
