import { spawn } from "node:child_process";
import type { ComparisonRequest } from "./contracts";

// Titles are single argv elements, but control characters would corrupt window titles.
const cleanTitle = (title: string) => title.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();

export function comparisonArguments(request: ComparisonRequest): string[] {
  const options: string[] = request.solo ? ["-solo"] : [];
  request.sides.forEach((side, index) => {
    if (side.title && cleanTitle(side.title)) options.push(`-title${index + 1}=${cleanTitle(side.title)}`);
    if (side.readOnly) options.push(`-ro${index + 1}`);
  });
  return [...options, "--", ...request.sides.map(side => side.path)];
}

/** Starts the desktop app and resolves with its process ID once spawned. */
export function launchDesktop(
  executable: string,
  args: readonly string[],
  onFailure: (error: Error) => void,
  onExit?: () => void
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { shell: false, windowsHide: true, stdio: "ignore" });
    let started = false;
    child.once("spawn", () => {
      started = true;
      // The user-owned desktop app must remain open after the extension shuts down.
      child.unref();
      resolve(child.pid);
    });
    child.once("error", error => {
      const failure = new Error(`Could not start CompareCraft (${executable}): ${error.message}`);
      if (started) onFailure(failure);
      else reject(failure);
    });
    child.once("exit", (code, signal) => {
      if (code !== 0) {
        onFailure(new Error(`CompareCraft exited with ${signal ? `signal ${signal}` : `code ${code}`}. See the desktop application for details.`));
      }
      onExit?.();
    });
  });
}
