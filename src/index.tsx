import { render } from "solid-js/web";
import App from "./App";
import { setHost } from "./host";
import { tauriHost } from "./host/tauri";
import "./styles.css";

setHost(tauriHost);

render(() => <App />, document.getElementById("root")!);
