import Cocoa
import Darwin
import FinderSync

final class FinderInvocation: NSObject {
    let id: String
    let urls: [URL]

    init(id: String, urls: [URL]) {
        self.id = id
        self.urls = urls
    }
}

@objc(CompareCraftFinderSync)
final class CompareCraftFinderSync: FIFinderSync {
    private let group = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: "group.dev.comparecraft.app"
    )
    private var watcher: DispatchSourceFileSystemObject?

    override init() {
        super.init()
        reloadRoots()
        if let group = group {
            let descriptor = open(group.path, O_EVTONLY)
            if descriptor >= 0 {
                let source = DispatchSource.makeFileSystemObjectSource(
                    fileDescriptor: descriptor, eventMask: [.write], queue: .main
                )
                source.setEventHandler { [weak self] in self?.reloadRoots() }
                source.setCancelHandler { close(descriptor) }
                watcher = source
                source.resume()
            }
        } else {
            NSLog("CompareCraft Finder: App Group unavailable; check signing and entitlements")
        }
    }

    deinit { watcher?.cancel() }

    private func snapshot() -> FinderMenuSnapshot? {
        guard let group = group,
              let data = try? Data(contentsOf: group.appendingPathComponent("finder-menu.json")),
              let snapshot = try? JSONDecoder().decode(FinderMenuSnapshot.self, from: data),
              snapshot.version == 1 else { return nil }
        return snapshot
    }

    private func reloadRoots() {
        let roots = snapshot()?.roots ?? []
        FIFinderSyncController.default().directoryURLs = Set(roots.map { URL(fileURLWithPath: $0) })
    }

    private func bookmarkURL(_ kind: String) -> URL? {
        group?.appendingPathComponent("left-\(kind).bookmark")
    }

    private func withAccess<Result>(_ snapshot: FinderMenuSnapshot, selected: [URL], body: () -> Result) -> Result {
        var accessed = selected.filter { $0.startAccessingSecurityScopedResource() }
        for (kind, path) in [("file", snapshot.leftFile), ("folder", snapshot.leftFolder)] {
            guard let path = path, let location = bookmarkURL(kind),
                  let data = try? Data(contentsOf: location) else { continue }
            var stale = false
            guard let url = try? URL(resolvingBookmarkData: data, options: [.withSecurityScope, .withoutUI],
                                     relativeTo: nil, bookmarkDataIsStale: &stale),
                  FinderMenuSnapshot.canonical(url) == FinderMenuSnapshot.canonical(URL(fileURLWithPath: path)) else { continue }
            if url.startAccessingSecurityScopedResource() { accessed.append(url) }
            if stale, let refreshed = try? url.bookmarkData(options: [.withSecurityScope, .securityScopeAllowOnlyReadAccess],
                                                          includingResourceValuesForKeys: nil, relativeTo: nil) {
                try? refreshed.write(to: location, options: .atomic)
            }
        }
        defer { accessed.forEach { $0.stopAccessingSecurityScopedResource() } }
        return body()
    }

    override func menu(for menuKind: FIMenuKind) -> NSMenu? {
        guard menuKind == .contextualMenuForItems,
              let urls = FIFinderSyncController.default().selectedItemURLs(),
              let current = snapshot() else { return nil }
        return withAccess(current, selected: urls) {
            let actions = current.actions(for: urls)
            guard !actions.isEmpty else { return nil }
            let menu = NSMenu(title: "CompareCraft")
            for action in actions {
                let item = NSMenuItem(title: action.label, action: #selector(invoke(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = FinderInvocation(id: action.id, urls: urls)
                item.image = icon(for: action)
                menu.addItem(item)
            }
            return menu
        }
    }

    private func icon(for action: FinderMenuAction) -> NSImage? {
        let symbol: String
        switch action.id {
        case "selectLeft": symbol = "doc.badge.plus"
        case "selectLeftFolder": symbol = "folder.badge.plus"
        case "compareStaged": symbol = "doc.on.doc"
        case "compareStagedFolder": symbol = "folder"
        case "sync": symbol = "arrow.triangle.2.circlepath"
        case "merge": symbol = "arrow.triangle.merge"
        case "clearLeft", "clearLeftFolder": symbol = "xmark.circle"
        default: symbol = "square.split.2x1"
        }
        return NSImage(systemSymbolName: symbol, accessibilityDescription: action.label)
    }

    @objc private func invoke(_ sender: NSMenuItem) {
        guard let invocation = sender.representedObject as? FinderInvocation,
              let current = snapshot() else { return }
        withAccess(current, selected: invocation.urls) {
            guard let action = current.actions(for: invocation.urls).first(where: { $0.id == invocation.id }) else {
                NSLog("CompareCraft Finder: selection changed; reopen the menu")
                return
            }
            if action.id == "selectLeft" || action.id == "selectLeftFolder" {
                do {
                    let kind = action.id == "selectLeftFolder" ? "folder" : "file"
                    guard let location = bookmarkURL(kind) else { return }
                    let data = try invocation.urls[0].bookmarkData(
                        options: [.withSecurityScope, .securityScopeAllowOnlyReadAccess],
                        includingResourceValuesForKeys: nil, relativeTo: nil
                    )
                    try data.write(to: location, options: .atomic)
                } catch {
                    NSLog("CompareCraft Finder: could not retain selected-item access: %@", error.localizedDescription)
                    return
                }
            }
            let application = Bundle.main.bundleURL.deletingLastPathComponent()
                .deletingLastPathComponent().deletingLastPathComponent()
            guard application.pathExtension == "app" else {
                NSLog("CompareCraft Finder: containing app bundle not found")
                return
            }
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.arguments = FinderMenuSnapshot.arguments(for: action, urls: invocation.urls)
            configuration.createsNewApplicationInstance = true
            configuration.activates = !action.id.hasPrefix("selectLeft") && !action.clearsLeft
            NSWorkspace.shared.openApplication(at: application, configuration: configuration) { _, error in
                if let error = error { NSLog("CompareCraft Finder: launch failed: %@", error.localizedDescription) }
            }
        }
    }
}