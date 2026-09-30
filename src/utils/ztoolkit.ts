import { ZoteroToolkit } from "zotero-plugin-toolkit/ztoolkit";
import { config } from "../../package.json";

export function createZToolkit(): ZoteroToolkit {
  const _ztoolkit = new ZoteroToolkit();
  _ztoolkit.basicOptions.log.prefix = `[${config.addonName}]`;
  _ztoolkit.basicOptions.log.disableConsole = false;
  _ztoolkit.UI.basicOptions.ui.enableElementJSONLog = __env__ === "development";
  _ztoolkit.basicOptions.api.pluginID = config.addonID;
  return _ztoolkit;
}

export type ZToolkit = ReturnType<typeof createZToolkit>;
