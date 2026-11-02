import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { resolve, join, extname, sep } from "node:path";
import { BackendClient } from "../../extensions/vscode/src/backend";
import type { FNode, FolderResult, Summary } from "../../src/api";

async function folderResult(left: string, right: string, options: { dotNamesFirst?: boolean }): Promise<FolderResult> {
  const summary: Summary = { files: 0, same: 0, similar: 0, diff: 0, leftOnly: 0, rightOnly: 0, errors: 0 };
  const walk = async (rel: string): Promise<FNode[]> => {
    const names = [...new Set([...await readdir(join(left, rel)), ...await readdir(join(right, rel))])].sort();
    const nodes = await Promise.all(names.map(async (name): Promise<FNode> => {
      const path = rel ? `${rel}/${name}` : name;
      const [l, r] = await Promise.all([left, right].map(async (base) => {
        try { return await stat(join(base, path)); }
        catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
          throw error;
        }
      }));
      const dir = !!(l ?? r)?.isDirectory();
      const status = !l ? "right" : !r ? "left" : l.size === r.size && Math.abs(l.mtimeMs - r.mtimeMs) < 2000 ? "same" : "diff";
      if (!dir) {
        summary.files++;
        if (status === "left") summary.leftOnly++;
        else if (status === "right") summary.rightOnly++;
        else summary[status]++;
      }
      return {
        name, rel: path.split(sep).join("/"), dir, status,
        left: l ? { name, size: l.size, modified: l.mtimeMs } : undefined,
        right: r ? { name, size: r.size, modified: r.mtimeMs } : undefined,
        children: dir && l && r ? await walk(path) : undefined,
      };
    }));
    const collator = new Intl.Collator("en", { ignorePunctuation: true, sensitivity: "base" });
    return nodes.sort((first, second) => Number(second.dir) - Number(first.dir)
      || (options.dotNamesFirst === false ? 0 : Number(second.name.startsWith(".")) - Number(first.name.startsWith(".")))
      || collator.compare(first.name, second.name));
  };
  return { root: { name: "", rel: "", dir: true, status: "same", children: await walk("") }, summary };
}

export default defineConfig({
  plugins: [
    solid(),
    {
      name: "comparison-test-host",
      async configureServer(server) {
        const backend = await BackendClient.start(
          process.env.COMPARECRAFT_BACKEND ?? resolve(`src-tauri/target/debug/comparecraft-backend${process.platform === "win32" ? ".exe" : ""}`),
          { client: { name: "ui-tests", version: "0" }, log: (line) => console.error(line) },
        );
        server.httpServer?.once("close", () => void backend.dispose());
        server.middlewares.use("/test-invoke", async (request, response) => {
          try {
            let body = "";
            for await (const chunk of request) body += chunk;
            const { cmd, args = {} } = JSON.parse(body);
            const methods: Record<string, string> = {
              path_info: "path.info", load_text: "text.load", diff_texts: "text.diff",
              hex_align: "hex.align", compare_tables: "table.compare", pix_compare: "pix.compare", pix_image: "pix.image",
            };
            let result: unknown;
            if (cmd === "compare_folders") result = await folderResult(args.left, args.right, args.options ?? {});
            else if (cmd === "load_settings") result = {};
            else if (cmd === "list_sessions") result = [];
            else if (cmd === "find_session") result = null;
            else if (cmd === "save_session" || cmd === "save_settings") result = null;
            else if (cmd === "read_bytes") result = (await readFile(args.path)).subarray(args.offset, args.offset + args.len).toString("base64");
            else if (cmd === "read_data_url") {
              const data = await readFile(args.path);
              result = { url: `data:image/${extname(args.path).slice(1)};base64,${data.toString("base64")}`, size: data.length };
            } else if (cmd === "save_text") {
              await writeFile(args.path, args.lines.join("\n") + (args.finalNewline ? "\n" : ""));
              result = await backend.request("path.info", { path: args.path });
            } else if (methods[cmd]) result = await backend.request(methods[cmd], args);
            else throw new Error(`Unsupported test host command: ${cmd}`);
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify(result));
          } catch (error) {
            response.statusCode = 500;
            response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
          }
        });
      },
    },
  ],
  server: { host: "127.0.0.1", port: 1430, strictPort: true },
});
