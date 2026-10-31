import { render } from "solid-js/web";
import App from "../../src/App";
import { setHost } from "../../src/host";
import "../../src/styles.css";

setHost({
  name: "tauri",
  invoke: async (cmd, args) => {
    if (cmd === "take_launch_spec") {
      const spec = new URLSearchParams(location.search).get("spec");
      return spec ? JSON.parse(spec) : null;
    }
    const response = await fetch("/test-invoke", { method: "POST", body: JSON.stringify({ cmd, args }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    return data;
  },
  listen: async () => () => {},
  ask: async () => true,
  message: async () => "Ok",
  open: async () => null,
  save: async () => null,
  readText: async () => "",
  writeText: async () => {},
  openUrl: async () => {},
  openPath: async () => {},
  revealItemInDir: async () => {},
  window: () => ({ close: async () => {}, onCloseRequested: async () => () => {} }),
});

render(() => <App />, document.getElementById("root")!);
