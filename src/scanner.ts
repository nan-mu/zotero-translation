import {
  ATTACHMENT_TITLES,
  DocumentStatus,
  GroupMember,
  TAGS,
} from "./constants";
import { diagnostics } from "./diagnostics";
import { sha256File } from "./hasher";
import { AuthError, HttpClientError, httpClient } from "./http-client";
import { settings } from "./settings";
import { stateStore } from "./state-store";
import { repo } from "./zotero-repository";

export interface ScanSummary {
  scanned: number;
  completedLocal: number;
  missingPdf: number;
  submitted: number;
  pending: number;
  imported: number;
  failedMarked: number;
  cleaned: number;
  errors: string[];
  pausedForAuth: boolean;
}

export class Scanner {
  async run(): Promise<ScanSummary> {
    const summary: ScanSummary = {
      scanned: 0,
      completedLocal: 0,
      missingPdf: 0,
      submitted: 0,
      pending: 0,
      imported: 0,
      failedMarked: 0,
      cleaned: 0,
      errors: [],
      pausedForAuth: false,
    };

    await stateStore.cleanupStaleTempFiles();

    if (settings.isPausedForAuth()) {
      summary.pausedForAuth = true;
      summary.errors.push("Paused due to prior 401/403; fix Token and resume");
      this.persistSummary(summary);
      return summary;
    }

    const items = await repo.findItemsNeedingTranslation();
    summary.scanned = items.length;

    const groups = new Map<string, GroupMember[]>();

    for (const { item, libraryID, itemKey } of items) {
      try {
        // Re-check trigger tag
        if (!item.hasTag(TAGS.NEED)) {
          continue;
        }

        const dual = repo.findReadableAttachmentByTitle(
          item,
          ATTACHMENT_TITLES.DUAL,
        );
        if (dual && (await repo.attachmentFileExists(dual))) {
          await repo.markCompleted(item);
          summary.completedLocal += 1;
          continue;
        }

        if (item.hasTag(TAGS.FAILED)) {
          continue;
        }

        const source = repo.findSourcePdf(item);
        if (!source) {
          await repo.markMissingPdf(item);
          summary.missingPdf += 1;
          continue;
        }

        await repo.clearMissingPdf(item);
        const path = await repo.getAttachmentPath(source);
        if (!path) {
          await repo.markMissingPdf(item);
          summary.missingPdf += 1;
          continue;
        }

        const hash = await sha256File(path);
        const member: GroupMember = {
          libraryID,
          itemKey,
          sourceAttachmentKey: source.key,
        };
        const list = groups.get(hash) || [];
        list.push(member);
        groups.set(hash, list);
      } catch (e) {
        const msg = `Item ${libraryID}/${itemKey}: ${String(e)}`;
        diagnostics.error(msg);
        summary.errors.push(msg);
      }
    }

    if (groups.size === 0) {
      summary.cleaned += await this.processCleanupQueue(new Set());
      this.persistSummary(summary);
      return summary;
    }

    let remoteMap = new Map<string, DocumentStatus>();
    try {
      const docs = await httpClient.listDocuments();
      remoteMap = new Map(docs.map((d) => [d.id, d.status]));
    } catch (e) {
      if (e instanceof AuthError) {
        settings.setPausedForAuth(true);
        summary.pausedForAuth = true;
        summary.errors.push("Auth failed (401/403); auto processing paused");
        diagnostics.error(summary.errors[summary.errors.length - 1]);
        this.persistSummary(summary);
        return summary;
      }
      const msg = `ListDocuments failed: ${String(e)}`;
      diagnostics.error(msg);
      summary.errors.push(msg);
      this.persistSummary(summary);
      return summary;
    }

    for (const [hash, members] of groups) {
      try {
        await this.processHashGroup(hash, members, remoteMap, summary);
      } catch (e) {
        if (e instanceof AuthError) {
          settings.setPausedForAuth(true);
          summary.pausedForAuth = true;
          summary.errors.push("Auth failed (401/403); auto processing paused");
          break;
        }
        const msg = `Hash ${diagnostics.shortHash(hash)}: ${String(e)}`;
        diagnostics.error(msg);
        summary.errors.push(msg);
      }
    }

    const stillNeeded = new Set(groups.keys());
    summary.cleaned += await this.processCleanupQueue(stillNeeded);
    this.persistSummary(summary);
    return summary;
  }

  private persistSummary(summary: ScanSummary): void {
    const text = [
      `time=${new Date().toISOString()}`,
      `scanned=${summary.scanned}`,
      `completedLocal=${summary.completedLocal}`,
      `missingPdf=${summary.missingPdf}`,
      `submitted=${summary.submitted}`,
      `pending=${summary.pending}`,
      `imported=${summary.imported}`,
      `failedMarked=${summary.failedMarked}`,
      `cleaned=${summary.cleaned}`,
      `pausedForAuth=${summary.pausedForAuth}`,
      summary.errors.length
        ? `errors=${summary.errors.slice(0, 5).join(" | ")}`
        : "errors=",
    ].join("\n");
    settings.setLastScanSummary(text);
  }

  private async processHashGroup(
    hash: string,
    members: GroupMember[],
    remoteMap: Map<string, DocumentStatus>,
    summary: ScanSummary,
  ): Promise<void> {
    let status = remoteMap.get(hash);

    if (!status) {
      // Upload once
      const first = members[0];
      const parent = await repo.getItem(first.libraryID, first.itemKey);
      if (!parent || !parent.hasTag(TAGS.NEED)) {
        return;
      }
      const source = await Zotero.Items.getByLibraryAndKeyAsync(
        first.libraryID,
        first.sourceAttachmentKey,
      );
      if (!source) {
        return;
      }
      const path = await repo.getAttachmentPath(source);
      if (!path) {
        return;
      }
      const bytes = await repo.readFileBytes(path);
      const record = await httpClient.submitDocument(hash, bytes);
      status = record.status;
      remoteMap.set(hash, status);
      if (status === "pending") {
        summary.submitted += 1;
      }
    }

    if (status === "pending") {
      summary.pending += members.length;
      return;
    }

    if (status === "error") {
      for (const m of members) {
        const item = await repo.getItem(m.libraryID, m.itemKey);
        if (!item || !item.hasTag(TAGS.NEED)) {
          continue;
        }
        if (item.hasTag(TAGS.FAILED)) {
          continue;
        }
        // If dual already exists, repair instead
        const dual = repo.findReadableAttachmentByTitle(
          item,
          ATTACHMENT_TITLES.DUAL,
        );
        if (dual && (await repo.attachmentFileExists(dual))) {
          await repo.markCompleted(item);
          summary.completedLocal += 1;
          continue;
        }
        await repo.markFailed(item);
        summary.failedMarked += 1;
      }
      return;
    }

    if (status !== "down") {
      diagnostics.error(
        `Unknown status for ${diagnostics.shortHash(hash)}: ${String(status)}`,
      );
      return;
    }

    await stateStore.ensureTempDir();
    const dest = stateStore.dualTempPath(hash);
    try {
      await httpClient.downloadDual(hash, dest);
    } catch (e) {
      if (e instanceof HttpClientError && (e.status === 404 || e.status === 409)) {
        diagnostics.warn(
          `Download not ready for ${diagnostics.shortHash(hash)}: ${e.status}`,
        );
        return;
      }
      throw e;
    }

    let allDone = true;
    for (const m of members) {
      try {
        const ok = await this.importForMember(m, dest);
        if (ok) {
          summary.imported += 1;
        } else {
          allDone = false;
        }
      } catch (e) {
        allDone = false;
        diagnostics.error(
          `Import ${m.libraryID}/${m.itemKey}: ${String(e)}`,
        );
        summary.errors.push(`Import ${m.itemKey}: ${String(e)}`);
      }
    }

    // Check whether any remaining consumer still needs this hash
    if (allDone) {
      stateStore.enqueueCleanup(hash);
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const IOUtilsAny = (globalThis as any).IOUtils;
      await IOUtilsAny.remove(dest);
    } catch {
      diagnostics.warn(`Failed to remove temp ${dest}`);
    }
  }

  private async importForMember(
    member: GroupMember,
    dualPath: string,
  ): Promise<boolean> {
    const item = await repo.getItem(member.libraryID, member.itemKey);
    if (!item) {
      return true; // no longer needed
    }
    if (!item.hasTag(TAGS.NEED)) {
      return true; // user cancelled
    }

    const existing = repo.findReadableAttachmentByTitle(
      item,
      ATTACHMENT_TITLES.DUAL,
    );
    if (existing && (await repo.attachmentFileExists(existing))) {
      await repo.markCompleted(item);
      return true;
    }

    const attachment = await repo.importDualPdf(item, dualPath);
    const path = await repo.getAttachmentPath(attachment);
    if (!path || attachment.parentItemID !== item.id) {
      throw new Error("Imported attachment validation failed");
    }

    // Re-read parent before tag commit
    const fresh = await repo.getItem(member.libraryID, member.itemKey);
    if (!fresh || !fresh.hasTag(TAGS.NEED)) {
      return true;
    }
    await repo.markCompleted(fresh);
    return true;
  }

  private async processCleanupQueue(
    stillNeededHashes: Set<string>,
  ): Promise<number> {
    let cleaned = 0;
    const queue = stateStore.getCleanupQueue();
    for (const entry of queue) {
      if (stillNeededHashes.has(entry.hash)) {
        continue;
      }
      try {
        await httpClient.deleteDocument(entry.hash);
        stateStore.removeCleanup(entry.hash);
        cleaned += 1;
        diagnostics.info(`Deleted remote ${diagnostics.shortHash(entry.hash)}`);
      } catch (e) {
        if (e instanceof AuthError) {
          settings.setPausedForAuth(true);
          throw e;
        }
        diagnostics.warn(
          `DELETE ${diagnostics.shortHash(entry.hash)} failed: ${String(e)}`,
        );
      }
    }
    return cleaned;
  }
}

export const scanner = new Scanner();
