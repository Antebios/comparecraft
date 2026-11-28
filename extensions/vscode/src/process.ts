import { spawn } from "node:child_process";

export { comparisonArguments, DESKTOP_VIEWS, desktopViewArguments } from "./desktopArgs";

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
