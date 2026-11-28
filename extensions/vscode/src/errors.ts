/** Errors shared by every extension host (desktop, remote and browser); no Node or VS Code imports. */

export const ErrorCode = {
  parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603,
  notInitialized: -32002, cancelled: -32800, unsupportedProtocol: -32010, io: -32020, tooLarge: -32021, busy: -32022
} as const;

/** A failed comparison-engine request (helper or WebAssembly), with the protocol error code. */
export class BackendError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) {
    super(message);
  }
}

/** The desktop app or helper is missing or its configured path is invalid. */
export class InstallationError extends Error {}

/**
 * An operation this environment doesn't allow (for example the desktop app in a remote window, or
 * saving in Restricted Mode). `fix: "trust"` means trusting the workspace would allow it.
 */
export class UnavailableError extends Error {
  constructor(message: string, readonly fix?: "trust") {
    super(message);
    this.name = "UnavailableError";
  }
}

export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
