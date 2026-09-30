import { ATTACHMENT_TITLES, TAGS } from "./constants";
import { diagnostics } from "./diagnostics";
import { sha256File } from "./hasher";
import { AuthError, httpClient } from "./http-client";
import { settings } from "./settings";
import { scheduler } from "./scheduler";
import { repo } from "./zotero-repository";

export async function retrySelectedTranslations(): Promise<void> {
  const zoteroPane = Zotero.getActiveZoteroPane();
  if (!zoteroPane) {
    return;
  }
  const selected = zoteroPane.getSelectedItems();
  const hashesRetried = new Set<string>();

  for (const item of selected) {
    if (!item.isRegularItem()) {
      continue;
    }
    if (!repo.isWritablePersonalLibrary(item.libraryID)) {
      continue;
    }

    const dual = repo.findReadableAttachmentByTitle(
      item,
      ATTACHMENT_TITLES.DUAL,
    );
    if (dual && (await repo.attachmentFileExists(dual))) {
      await repo.markCompleted(item);
      continue;
    }

    const source = repo.findSourcePdf(item);
    if (!source) {
      diagnostics.warn(`Retry skipped (no Full Text PDF): ${item.key}`);
      continue;
    }
    const path = await repo.getAttachmentPath(source);
    if (!path) {
      diagnostics.warn(`Retry skipped (source missing file): ${item.key}`);
      continue;
    }

    const hash = await sha256File(path);
    try {
      if (!hashesRetried.has(hash)) {
        await httpClient.retryDocument(hash);
        hashesRetried.add(hash);
      }
      await repo.clearFailedKeepNeed(item);
      if (!item.hasTag(TAGS.NEED)) {
        item.addTag(TAGS.NEED);
        await item.saveTx();
      }
      settings.setPausedForAuth(false);
    } catch (e) {
      if (e instanceof AuthError) {
        settings.setPausedForAuth(true);
        diagnostics.error("Retry paused: auth failure");
        break;
      }
      // 404: need re-submit on next scan — keep failed until submit succeeds
      diagnostics.error(`Retry API failed for ${item.key}: ${String(e)}`);
      try {
        const bytes = await repo.readFileBytes(path);
        await httpClient.submitDocument(hash, bytes);
        await repo.clearFailedKeepNeed(item);
        hashesRetried.add(hash);
      } catch (e2) {
        diagnostics.error(`Retry resubmit failed: ${String(e2)}`);
      }
    }
  }

  await scheduler.requestScan("retry");
}
