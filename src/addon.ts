import { config } from "../package.json";
import hooks from "./hooks";
import { prefsUi } from "./prefs-ui";
import { createZToolkit, type ZToolkit } from "./utils/ztoolkit";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    env: "development" | "production";
    ztoolkit: ZToolkit;
    initialized?: boolean;
  };
  public hooks: typeof hooks;
  public prefsUi: typeof prefsUi;

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      ztoolkit: createZToolkit(),
    };
    this.hooks = hooks;
    this.prefsUi = prefsUi;
  }
}

export default Addon;
