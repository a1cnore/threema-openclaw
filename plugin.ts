import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { threemaPlugin } from "./src/channel-plugin.js";

let _runtime: any = null;

export function getThreemaRuntime() {
  if (!_runtime) throw new Error("Threema runtime not initialized");
  return _runtime;
}

const plugin = {
  id: "threema-openclaw",
  name: "Threema OpenClaw",
  description: "Threema messaging channel via multi-device desktop emulation",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    _runtime = api.runtime;
    api.registerChannel({ plugin: threemaPlugin });
    api.logger.info("Threema channel plugin registered");
  },
};

export default plugin;
