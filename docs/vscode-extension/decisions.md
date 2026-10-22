# Confirmed decisions and behavior boundaries

See [plan.md](plan.md) for tasks and [handoff.md](handoff.md) for current status.
These are user-confirmed product decisions and implementation constraints.
Protocol and crate boundary were decided in T007: [backend-protocol.md](backend-protocol.md).

## Modes and installation

- One extension, explicit embedded/desktop commands, configurable default initially
  embedded. Missing embedded capability presents a notice and desktop action;
  never silently switch, even during external-only delivery.
- Existing desktop installation is required. Add a headless helper to installers;
  external-only commands remain compatible with older installs where supported.
- Separate user/machine executable overrides for desktop and backend. Invalid
  explicit paths fail visibly rather than falling through to a different install.
- On Windows check `%LOCALAPPDATA%\CompareCraft`, not a hardcoded username.
  No Windows PATH modification is required. Verify other installer candidates.
- Inspect real macOS bundle and Linux deb/rpm/AppImage layouts before assuming
  helper locations. Include signing/runtime dependencies in packaging validation.
- Ordinary extension launches use executable plus argument arrays, never shell
  interpolation. Support spaces and option-like filenames using CLI separation.
- Require workspace trust for executable launches and Git mutations. Workspace
  configuration must not supply executable commands.
- Headless communication is versioned/capability-negotiated stdin/stdout;
  diagnostics go to stderr. No TCP listener or OS service.
- Handle crash/shutdown/pending requests explicitly; do not orphan helpers.
- Start with local Windows/macOS/Linux desktop. Detect and explain deferred
  SSH/WSL/container/browser/unsupported-virtual-resource environments.

## Content and editing safety

- Editor commands use current buffers; no automatic save. Compare to Saved is
  specifically current-buffer versus on-disk content.
- Selections, clipboard, revisions, and unsaved buffers may become immutable
  read-only snapshots. Preserve titles and original resource identity.
- Temporary snapshots are never source-document write-back destinations.
- A launcher may exit after handing off to an existing GUI. Do not delete inputs
  merely because that launcher exited. Use proven completion tracking and
  conservative recovery/retention where lifetime is uncertain.
- Keep ownership metadata; cleanup only owned files. Do not broadly delete temp
  directories. Final retention/recovery policy is decided and tested in T004.
- Embedded writes use document-version checks and VS Code document APIs, preserving
  undo/save/dirty state. Close/reload must not silently lose edits.
- Desktop conflict writes must protect already dirty VS Code buffers and detect
  intervening state changes. Do not blindly import or overwrite external results.
- Preserve read-only, format/backup behavior, and confirmation for destructive
  folder actions. Keep extension settings/session storage separate from desktop
  preferences unless deliberate sharing is specified.

## Git behavior

- Extend the built-in Git workflows; do not create a duplicate provider.
  Use supported APIs and explicit commands, not private VS Code internals.
- Do not promise a global override of every native merge-editor action.
- Support HEAD/working, HEAD/index, index/working, chosen revisions, and forwarding
  existing diffs, including revision-backed documents.
- Read actual unmerged index stages: base when available, current, incoming,
  and working result. For ordinary three-input CLI merges the conceptual mapping
  is `ccomp LOCAL REMOTE BASE MERGED`; verify quoting and missing-stage behavior.
- During merge, current is normally the checked-out branch. During rebase,
  current is the new base plus replayed commits, incoming the commit being
  replayed. Do not label these simply "your" and "their" changes.
- Handle add/add, modify/delete, rename, and binary conflicts explicitly.
  Unsupported cases explain limitations and preserve Git state.
- Saving is not staging. Stage Resolved File is an explicit review action.
  Never automatically commit, continue, or abort Git operations.
- Revalidate index/worktree/document state before applying a stale result or
  staging. Absence of conflict markers alone does not prove correctness.
- Git mergetool/difftool setup is opt-in. Recommend repository-local scope;
  global configuration requires separate explicit consent.
- Show proposed settings, preserve existing configuration, and provide reversible
  setup without overwriting subsequent user changes.
- Waiting for the GUI to close does not establish resolution success. Keep Git's
  confirmation unless success/cancel semantics justify `trustExitCode=true`.
- Git tool command strings use Git's shell syntax and require platform quoting
  tests, unlike ordinary shell-free extension spawning.
- Desktop Git tools work independently of VS Code. A terminal-to-embedded bridge
  is not part of initial registration.

## Remaining engineering decisions

- T007 (decided): no crate extraction; the Tauri-free engine stays in
  `comparecraft_lib` and the helper is a third bin. Bounded protocol v1 (framing,
  IDs, payload limits, cancellation, capabilities, explicit failures) is in
  [backend-protocol.md](backend-protocol.md). The helper is read-only; writes stay
  in VS Code document APIs.
- T004: snapshot ownership, lifetime and recovery based on observed process behavior.
- T009 (decided): `src/host/` is the only module that touches platform services.
  `tauriHost` is set by the desktop entry point and `vscodeHost` by the webview
  entry; Tauri packages are imported type-only by shared code, so the separate
  `vite.webview.config.ts` bundle contains no Tauri runtime.
- T010 (decided): a `WebviewPanel` with a serializer, not a `CustomEditor`.
  A comparison spans two documents, and custom editors bind one resource. Each
  side writes through its VS Code `TextDocument` (`WorkspaceEdit` + `save()`), so
  undo, dirty state, local history, and save participants behave as for any edit.
  A per-panel guard remembers the exact text each side loaded; saves are refused
  if the document (VS Code buffer or disk) changed since. Read-only and
  in-memory sides (saved-on-disk, clipboard, Git revisions) are content sides.
  Panel close cannot be vetoed, so closing with unsaved side text offers
  Restore Comparison or Open as Untitled; reload restores from webview state,
  including unsaved text. Settings are separate from the desktop app
  (`globalState`); sessions, reports, backups, and Open With are desktop-only.
- Webviews require restrictive CSP/resource roots and validated message dispatch.
  Never eagerly load Tauri runtime services into the extension webview.
- Preserve desktop behavior through extraction; no unnecessary module churn.
- Marketplace publisher setup/publication is separate from producing a VSIX.
- The Beyond Compare extension is a workflow reference, not a source of copied
  implementation, branding, or assets.

## References

- [VS Code webviews](https://code.visualstudio.com/api/extension-guides/webview)
- [VS Code custom editors](https://code.visualstudio.com/api/extension-guides/custom-editors)
- [VS Code merge conflicts](https://code.visualstudio.com/docs/sourcecontrol/merge-conflicts)
- [Git mergetool](https://git-scm.com/docs/git-mergetool)
- [Git difftool](https://git-scm.com/docs/git-difftool)
- [Beyond Compare extension workflows](https://github.com/ScooterSoftware/bcompare-vscode)
