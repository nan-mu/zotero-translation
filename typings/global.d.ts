declare const __env__: "production" | "development";

declare const _globalThis: typeof globalThis & {
  addon: import("../src/addon").default;
  ztoolkit: import("zotero-plugin-toolkit/ztoolkit").ZoteroToolkit;
};

declare namespace Zotero {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  var ZoteroTranslation: any;
}
