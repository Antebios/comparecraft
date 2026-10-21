import Foundation

struct FinderMenuAction: Codable {
    let id: String
    let label: String
    let flag: String
    let enabled: Bool
    let count: Int
    let kind: String
    let requiresLeft: Bool
    let clearsLeft: Bool
}

struct FinderMenuSnapshot: Codable {
    let version: Int
    let executable: String
    let actions: [FinderMenuAction]
    let leftFile: String?
    let leftFolder: String?
    let roots: [String]

    func actions(for urls: [URL]) -> [FinderMenuAction] {
        guard version == 1, (1...2).contains(urls.count),
              urls.allSatisfy({ $0.isFileURL }) else { return [] }
        let kinds = urls.map(Self.kind)
        guard let kind = kinds.first ?? nil,
              kinds.allSatisfy({ $0 == kind }) else { return [] }
        return actions.filter { action in
            guard action.enabled, action.count == urls.count,
                  action.kind == "either" || action.kind == kind else { return false }
            guard action.requiresLeft else { return true }
            let path = kind == "folder" ? leftFolder : leftFile
            guard let path = path else { return false }
            let left = URL(fileURLWithPath: path)
            guard Self.kind(left) == kind else { return false }
            return action.clearsLeft || Self.canonical(left) != Self.canonical(urls[0])
        }
    }

    static func kind(_ url: URL) -> String? {
        let resolved = url.resolvingSymlinksInPath()
        guard let values = try? resolved.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey]) else { return nil }
        if values.isDirectory == true { return "folder" }
        if values.isRegularFile == true { return "file" }
        return nil
    }

    static func canonical(_ url: URL) -> URL {
        url.resolvingSymlinksInPath().standardizedFileURL
    }

    static func arguments(for action: FinderMenuAction, urls: [URL]) -> [String] {
        action.clearsLeft ? [action.flag] : [action.flag, "--"] + urls.map(\.path)
    }
}