// Browser VS Code checks (VS Code for the Web in headless Chromium, run by scripts/test-web.cjs). The
// runner mounts a folder of sample files as the workspace.
import * as vscode from "vscode";
import type { TestApi } from "../../src/activate";
import type { EmbeddedPanel } from "../../src/embedded";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Check failed: ${message}`);
}

async function until<T>(what: string, probe: () => T | undefined | false | Promise<T | undefined | false>, timeout = 30000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

export async function run(): Promise<void> {
  check(vscode.env.uiKind === vscode.UIKind.Web, "runs in browser VS Code");
  const extension = vscode.extensions.all.find(candidate => candidate.packageJSON.name === "comparecraft");
  check(extension, "the extension is installed");
  const api = (await extension.activate()) as TestApi | undefined;
  check(api?.embedded, "test-mode activation exposes the panels");
  const commands = await vscode.commands.getCommands(true);
  for (const id of ["compareSelectedEmbedded", "gitCompareHead", "openDesktop", "checkBackend"]) check(commands.includes(`comparecraft.${id}`), `command ${id} is registered`);
  for (const operation of ["desktop", "git", "folder", "revealInOS"] as const) check(api.denial(operation), `${operation} is unavailable in the browser`);
  check(!api.denial("save"), "saving is allowed");

  const result = await vscode.commands.executeCommand<{ engine: string; environment: string } | undefined>("comparecraft.checkBackend");
  check(result?.engine === "wasm", `the WebAssembly engine compares (${JSON.stringify(result)})`);
  check(/browser/.test(result.environment), `environment ${result.environment}`);

  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  check(folder, "a workspace folder is open");
  const file = (name: string) => vscode.Uri.joinPath(folder, name);
  const opened = (before: Set<EmbeddedPanel>) => until("a new panel", () => api.embedded.all.find(panel => !before.has(panel)));

  const a = file("a.txt"), b = file("b.txt");
  let before = new Set(api.embedded.all);
  await vscode.commands.executeCommand("comparecraft.compareSelectedEmbedded", a, [a, b]);
  const panel = await opened(before);
  check(panel.state.spec.paths[0] === a.toString(), `sides are URIs (${panel.state.spec.paths[0]})`);
  await until("the webview to diff", () => panel.received.includes("diff_texts"));
  const invoke = (cmd: string, args: Record<string, unknown>) => panel.handle("invoke", { cmd, args });
  const loaded = await invoke("load_text", { path: a.toString() }) as { lines: string[]; readOnly: boolean };
  check(loaded.lines.join("|") === "one|two", `loaded ${loaded.lines.join("|")}`);
  const diff = await invoke("diff_texts", { left: ["one", "two"], right: ["one", "three"], rules: {} }) as { identical: boolean; important: number };
  check(diff.identical === false && diff.important === 1, `WebAssembly diff ${JSON.stringify(diff)}`);
  const merged = await invoke("merge_texts", { base: ["x"], left: ["x", "l"], right: ["r", "x"], rules: {} }) as { conflicts: number };
  check(merged.conflicts === 0, `WebAssembly merge ${JSON.stringify(merged)}`);
  check(!loaded.readOnly, "the mounted folder is writable");
  await invoke("save_text", { path: a.toString(), lines: ["one", "saved"], finalNewline: true });
  check(new TextDecoder().decode(await vscode.workspace.fs.readFile(a)) === "one\nsaved\n", "saved through the file system provider");
  const capabilities = await panel.handle("capabilities", {}) as { desktop: boolean; revealInOS: boolean };
  check(!capabilities.desktop && !capabilities.revealInOS, "no desktop app or file manager");
  panel.panel.dispose();

  const views = { hex: ["one.bin", "two.bin", "hex_align"], table: ["one.csv", "two.csv", "compare_tables"], picture: ["one.png", "two.png", "pix_compare"] } as const;
  for (const [kind, [left, right, method]] of Object.entries(views)) {
    before = new Set(api.embedded.all);
    await vscode.commands.executeCommand("comparecraft.compareSelectedEmbedded", file(left), [file(left), file(right)]);
    const view = await opened(before);
    check(view.state.spec.kind === kind, `${left} opens the ${kind} view (${view.state.spec.kind})`);
    await until(`the ${kind} view to compare`, () => view.received.includes(method));
    view.panel.dispose();
  }
  check(/browser/.test(await api.embedded.folderUnsupported([folder.toString(), folder.toString()]) ?? ""), "folder comparison explains it needs desktop VS Code");
  console.log("PASS: browser VS Code activates the web extension, compares, merges and saves text, and opens hex/table/picture views with the WebAssembly engine; desktop, Git and folder features are unavailable.");
}
