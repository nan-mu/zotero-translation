import { ATTACHMENT_TITLES, TAGS } from "./constants";
import { diagnostics } from "./diagnostics";

export interface TopItemRef {
  libraryID: number;
  itemKey: string;
  item: Zotero.Item;
}

function hasTag(item: Zotero.Item, tag: string): boolean {
  return item.hasTag(tag);
}

export class ZoteroRepository {
  async findItemsNeedingTranslation(): Promise<TopItemRef[]> {
    const search = new Zotero.Search();
    search.addCondition("tag", "is", TAGS.NEED);
    // Top-level items only (exclude attachments/notes)
    search.addCondition("itemType", "isNot", "attachment");
    search.addCondition("itemType", "isNot", "note");
    search.addCondition("itemType", "isNot", "annotation");
    const ids = await search.search();
    const items = await Zotero.Items.getAsync(ids);
    const out: TopItemRef[] = [];
    for (const item of items) {
      if (!item.isRegularItem()) {
        continue;
      }
      if (!this.isWritablePersonalLibrary(item.libraryID)) {
        diagnostics.info(
          `Skip non-writable/non-personal libraryID=${item.libraryID} item=${item.key}`,
        );
        continue;
      }
      out.push({ libraryID: item.libraryID, itemKey: item.key, item });
    }
    return out;
  }

  isWritablePersonalLibrary(libraryID: number): boolean {
    try {
      const library = Zotero.Libraries.get(libraryID);
      if (!library) {
        return false;
      }
      // User library only for v1
      if (library.libraryType !== "user") {
        return false;
      }
      return library.editable !== false;
    } catch {
      return libraryID === Zotero.Libraries.userLibraryID;
    }
  }

  getChildAttachments(item: Zotero.Item): Zotero.Item[] {
    const ids = item.getAttachments();
    return Zotero.Items.get(ids).filter((a) => a.isAttachment());
  }

  findReadableAttachmentByTitle(
    item: Zotero.Item,
    title: string,
  ): Zotero.Item | null {
    const matches = this.getChildAttachments(item).filter(
      (a) => a.getField("title") === title,
    );
    for (const att of matches) {
      if (this.isReadablePdf(att)) {
        return att;
      }
    }
    return null;
  }

  findSourcePdf(item: Zotero.Item): Zotero.Item | null {
    const matches = this.getChildAttachments(item).filter(
      (a) =>
        a.getField("title") === ATTACHMENT_TITLES.SOURCE &&
        this.isReadablePdf(a),
    );
    if (matches.length === 0) {
      return null;
    }
    if (matches.length > 1) {
      diagnostics.warn(
        `Multiple "${ATTACHMENT_TITLES.SOURCE}" on ${item.libraryID}/${item.key}; using newest dateAdded`,
      );
      matches.sort((a, b) => {
        const da = String(a.dateAdded || "");
        const db = String(b.dateAdded || "");
        return db.localeCompare(da);
      });
    }
    return matches[0];
  }

  isReadablePdf(att: Zotero.Item): boolean {
    try {
      if (att.isAttachment() !== true) {
        return false;
      }
      if (att.attachmentContentType && att.attachmentContentType !== "application/pdf") {
        // Still allow if file looks like PDF
      }
      const path = att.getFilePath();
      if (!path) {
        return false;
      }
      // Synchronous existence check via OS when possible
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const IOUtilsAny = (globalThis as any).IOUtils;
      // getFilePath may return string; existence checked async elsewhere if needed
      return typeof path === "string" && path.length > 0;
    } catch {
      return false;
    }
  }

  async attachmentFileExists(att: Zotero.Item): Promise<boolean> {
    const path = att.getFilePath();
    if (!path) {
      return false;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const IOUtilsAny = (globalThis as any).IOUtils;
    try {
      return Boolean(await IOUtilsAny.exists(path));
    } catch {
      return false;
    }
  }

  async getAttachmentPath(att: Zotero.Item): Promise<string | null> {
    const path = att.getFilePath();
    if (!path) {
      return null;
    }
    if (!(await this.attachmentFileExists(att))) {
      return null;
    }
    return String(path);
  }

  async markCompleted(item: Zotero.Item): Promise<void> {
    item.removeTag(TAGS.NEED);
    item.removeTag(TAGS.MISSING);
    item.removeTag(TAGS.FAILED);
    item.addTag(TAGS.DONE);
    await item.saveTx();
  }

  async markMissingPdf(item: Zotero.Item): Promise<void> {
    if (!hasTag(item, TAGS.MISSING)) {
      item.addTag(TAGS.MISSING);
      await item.saveTx();
    }
  }

  async clearMissingPdf(item: Zotero.Item): Promise<void> {
    if (hasTag(item, TAGS.MISSING)) {
      item.removeTag(TAGS.MISSING);
      await item.saveTx();
    }
  }

  async markFailed(item: Zotero.Item): Promise<void> {
    if (!hasTag(item, TAGS.FAILED)) {
      item.addTag(TAGS.FAILED);
      await item.saveTx();
    }
  }

  async clearFailedKeepNeed(item: Zotero.Item): Promise<void> {
    item.removeTag(TAGS.FAILED);
    if (!hasTag(item, TAGS.NEED)) {
      item.addTag(TAGS.NEED);
    }
    await item.saveTx();
  }

  async getItem(libraryID: number, itemKey: string): Promise<Zotero.Item | null> {
    const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, itemKey);
    return item || null;
  }

  async importDualPdf(
    parent: Zotero.Item,
    filePath: string,
  ): Promise<Zotero.Item> {
    const attachment = await Zotero.Attachments.importFromFile({
      file: filePath,
      parentItemID: parent.id,
      title: ATTACHMENT_TITLES.DUAL,
      contentType: "application/pdf",
    });
    // Ensure display title is exact
    if (attachment.getField("title") !== ATTACHMENT_TITLES.DUAL) {
      attachment.setField("title", ATTACHMENT_TITLES.DUAL);
      await attachment.saveTx();
    }
    return attachment;
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const IOUtilsAny = (globalThis as any).IOUtils;
    return await IOUtilsAny.read(path);
  }
}

export const repo = new ZoteroRepository();
