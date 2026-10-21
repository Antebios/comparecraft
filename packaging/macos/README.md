# macOS Finder Integration

## Status

CompareCraft includes an experimental Finder Sync extension for macOS 12 or later. The implementation was
developed on Linux, without access to a Mac. Portable Rust tests and plist/config checks are available locally;
the macOS PR jobs compile the native Swift extension and run its menu-model tests. Interactive activation,
sandbox permissions, App Group authorization, launching an already-running app, signing and notarization
still require native testing. Please report results rather than treating a successful build as runtime approval.

The extension uses Apple's Finder Sync API for comparison/synchronization commands. It does not add badges,
enumerate directory trees, change Finder's configuration, or install a launch agent. Its monitored scope is the
user's home directory and `/Volumes`. It intentionally does not provide background/sidebar/toolbar actions.

## Build

Install Xcode (including a macOS SDK), stable Rust, and the repository's supported Node.js version. Select the
intended Xcode installation with `xcode-select` if necessary, then run from the repository root:

```sh
npm ci
npm run test:finder
npm run app:build:macos
```

The build hook compiles arm64 and x86_64 extension executables with `xcrun swiftc`, combines them with `lipo`,
generates the extension plist version from the app version, signs the extension, and embeds it at:

```text
CompareCraft.app/Contents/PlugIns/CompareCraftFinder.appex
```

The generated extension is under `src-tauri/target/finder-extension/`. App bundles are under the selected Rust
target's `release/bundle/macos/` directory. `npm run app:build:bin` compiles the extension but does not create an
app bundle, so it cannot be used to test Finder activation. `tauri dev` likewise does not embed the extension.
The host remains a normal, unsandboxed desktop application; only the Finder extension is sandboxed.

## Signing

Without `APPLE_SIGNING_IDENTITY`, the app and extension receive ad-hoc signatures. This is useful for CI compilation,
not a guarantee that Finder will load it or grant its shared-container entitlement. Do not disable system
security protections. Use a development/distribution identity, identifiers you control, and appropriate
provisioning profiles when testing an entitled extension.

The default identifiers are:

| Purpose | Identifier |
| --- | --- |
| Host app | `dev.comparecraft.app` |
| Finder extension | `dev.comparecraft.app.finder` |
| Shared App Group | `group.dev.comparecraft.app` |

Both targets must be authorized for the same App Group and signed by the same development team. If you need
to use your own identifiers, update them consistently in the Tauri main config, the Rust `FINDER_GROUP` and
`FINDER_EXTENSION` constants, the extension's Info.plist and Swift group identifier, and both entitlement files.
The extension bundle identifier must remain prefixed by the containing app's identifier. Register the chosen
identifiers/capabilities in your Apple developer account as required by your signing method.

Set `APPLE_SIGNING_IDENTITY` to the identity used by Tauri and the extension build. Set
`COMPARECRAFT_FINDER_PROVISIONING_PROFILE` to the extension profile path, if required; the build copies it to
the extension's `Contents/embedded.provisionprofile`. Configure the containing app's matching provisioning
profile separately for your signing/distribution process. Provisioning profiles and private signing material
must not be committed. After changing signing profiles, remove the generated `finder-extension` directory
before rebuilding so stale profile data is not accidentally reused.

After bundling, inspect both signatures and verify the nested bundle:

```sh
codesign --verify --deep --strict --verbose=2 /Applications/CompareCraft.app
codesign -d --entitlements :- /Applications/CompareCraft.app
codesign -d --entitlements :- /Applications/CompareCraft.app/Contents/PlugIns/CompareCraftFinder.appex
```

The host must retain its App Group entitlement. The extension must retain App Sandbox, user-selected file
access, app-scope bookmark, and the matching App Group entitlements after final bundle signing. Notarization
and Gatekeeper acceptance are separate checks and are not established by the commands above.

The extension is signed before Tauri embeds it as a custom macOS bundle file, and Tauri signs the containing
app afterward. If a distribution workflow imports a certificate only during Tauri's later bundling phase,
make that signing identity available in the keychain before running the extension build hook as well. Do not
use `codesign --deep --force` to re-sign everything with the host entitlements; the extension has its own
sandbox entitlements and must keep them.

## Install and Enable

1. Copy the complete app bundle into `/Applications` or the user's `Applications` folder, then open it once.
2. In **Tools > Options > Startup > File manager integration**, enable the desired file and folder actions.
   Applying registers the embedded extension and publishes the shared menu snapshot. Existing preferences
   are preserved; new folder actions are opt-in.
3. Enable CompareCraft in System Settings's **Finder Extensions** section. On newer macOS versions look under
   **General > Login Items & Extensions**; on older versions search System Settings/Preferences for Extensions.
4. Open a Finder window inside your home directory and select an item. Close and reopen the context menu after
   changing a staged selection. If macOS has cached an older extension build, toggle it off/on in Settings;
   save file operations before relaunching Finder manually if that is still needed.

Options never forces `pluginkit -e use` or restarts Finder. You can inspect registration without changing it:

```sh
pluginkit -m -A -D -i dev.comparecraft.app.finder
```

If the extension was not discovered automatically, register the installed path and then enable it in Settings:

```sh
pluginkit -a /Applications/CompareCraft.app/Contents/PlugIns/CompareCraftFinder.appex
```

Do not leave two app copies with the same identifiers installed while testing; Finder may select a stale copy.

## State and Sandbox Design

The host keeps its existing preferences and independent file/folder staged paths in its normal configuration
directory. After applying integration preferences or changing staging, it atomically publishes `finder-menu.json`
to the App Group container obtained through Foundation, using `finder-menu.lock` to serialize publishers.
That snapshot contains only action metadata, enabled
preferences, staged paths and monitored roots, not sessions or general application settings.

The extension obtains the same container through Foundation, watches it for updates, and re-reads its snapshot
when building a menu. It saves read-only security-scoped bookmarks for staged items in `left-file.bookmark`
and `left-folder.bookmark`, resolving them only while checking or invoking a menu. Missing or inaccessible
staged paths are hidden. The CLI revalidates paths and preserves the existing per-kind locking/consumption rules.

Actions use `NSWorkspace.openApplication` with an argument array and a new host process, not shell commands.
The host's existing single-instance handling forwards comparisons to a running window. Staging/clear commands
can finish without opening a comparison. Test this handoff both with the app closed and already running.

## Native Test Checklist

- Fresh state: one file shows Select Left File only; one folder shows Select Left Folder only.
- Stage a file and a folder independently. Each matching right item offers Compare to Selected Left and Clear;
  Select Left remains available to replace the same-kind selection. Choosing the same left path hides Compare.
- Two files offer Compare/Merge; two folders offer Compare/Sync. Mixed selections, more than two items, remote
  URLs and Finder background clicks offer no actions. Sync opens its UI; it does not immediately modify files.
- Successful staged comparison clears only that kind of left selection. Direct two-item actions preserve both.
- Deleted items, broken links, stale bookmarks, renamed items and permission failures do not compare the wrong
  pair. Test symbolic links, Unicode, spaces, quotes and leading dashes in names.
- Repeat with the host closed and already running, separate Finder windows, an Open/Save dialog, and a mounted
  volume. Folders outside the configured home/Volumes scope are deliberately not registered.
- Verify document/folder/compare/merge/sync/clear icons in light/dark appearances and on Retina displays.
- Disable all actions in Options; the extension should expose no menu and monitor no roots. Re-enable and
  ensure menus return without restarting the host or extension.
- Verify Apple Silicon and Intel app bundles, registration after upgrades/moves, signatures/entitlements after
  bundling, and coexistence with other Finder extensions.

Report the macOS version, CPU architecture, app build/version, signing method (no secrets), `pluginkit` output,
the relevant checklist case, and Console logs filtered for **CompareCraft Finder** or **sandbox**. App Group
failures appear in Options or the extension log; an installed `.appex` alone is not proof it is enabled.

## Disable or Remove

Uncheck actions in Options to publish disabled state. Disable CompareCraft's Finder extension in System
Settings before removing the app. An optional unregister command is:

```sh
pluginkit -r /Applications/CompareCraft.app/Contents/PlugIns/CompareCraftFinder.appex
```

The App Group may retain `finder-menu.json`, its backup/lock, and bookmarks after uninstall. Do not delete unrelated
group-container files. Old manually created Automator Quick Actions remain separate; remove their workflows
from `~/Library/Services` if they duplicate the native menu.
