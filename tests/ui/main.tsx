import { render } from "solid-js/web";
import App from "../../src/App";
import { setHost } from "../../src/host";
import type { EventCallback, EventName } from "@tauri-apps/api/event";
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
  listen: async <Payload,>(name: EventName, handler: EventCallback<Payload>) => {
    const receive = (message: Event) => {
      const detail = (message as CustomEvent<{ name: string; payload: Payload }>).detail;
      if (detail.name === name) handler({ event: name, id: 0, payload: detail.payload });
    };
    window.addEventListener("comparecraft-test-event", receive);
    return () => window.removeEventListener("comparecraft-test-event", receive);
  },
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
