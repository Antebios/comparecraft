import { spawn } from "node:child_process";
import type { ComparisonRequest } from "./contracts";

export function comparisonArguments(request: ComparisonRequest): string[] {
  return ["--", request.left.path, request.right.path];
}

export function launchDesktop(
  executable: string,
  args: readonly string[],
  onFailure: (error: Error) => void,
  onExit?: () => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { shell: false, windowsHide: true, stdio: "ignore" });
    let started = false;
    child.once("spawn", () => {
      started = true;
      // The user-owned desktop app must remain open after the extension shuts down.
      child.unref();
      resolve();
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
