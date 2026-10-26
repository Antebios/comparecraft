import { message, openPath, revealItemInDir } from "../host";
import { errText } from "../api";
import { IS_MAC, type Command } from "../commands";

/** Which half of a two-sided element the pointer event landed on. */
export const sideOf = (e: MouseEvent): 0 | 1 => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return e.clientX < r.left + r.width / 2 ? 0 : 1;
};

const showError = (msg: string) => void message(msg, { kind: "error", title: "CompareCraft" });

/** "Open with Default Application" and "Show in File Manager" for the file returned by `path`. */
export function externalCommands(path: () => string | undefined, report: (msg: string) => void = showError, group = "ext"): Command[] {
  const wrap = (f: (p: string) => Promise<void>) => async () => {
    const p = path();
    if (!p) return;
    try {
      await f(p);
    } catch (err) {
      report(errText(err));
    }
  };
  return [
    { id: "open-default", menu: "File", group, label: "Open with Default Application", enabled: () => !!path(), run: wrap((p) => openPath(p)) },
    { id: "reveal", menu: "File", group, label: IS_MAC ? "Reveal in Finder" : "Show in File Manager", enabled: () => !!path(), run: wrap(revealItemInDir) },
  ];
}

/** Splits a command line into words; double or single quotes group words. */
export function shellWords(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
