import Foundation

@main
struct FinderMenuTests {
    static func main() throws {
        guard CommandLine.arguments.count == 2 else { fatalError("Finder snapshot fixture path required") }
        let fixture = URL(fileURLWithPath: CommandLine.arguments[1])
        let decoded = try JSONDecoder().decode(FinderMenuSnapshot.self, from: Data(contentsOf: fixture))
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let left = root.appendingPathComponent("left 'file'.txt")
        let right = root.appendingPathComponent("right file.txt")
        let leftFolder = root.appendingPathComponent("left folder")
        let rightFolder = root.appendingPathComponent("right folder")
        try Data("left".utf8).write(to: left)
        try Data("right".utf8).write(to: right)
        try FileManager.default.createDirectory(at: leftFolder, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: rightFolder, withIntermediateDirectories: true)
        let fresh = FinderMenuSnapshot(version: 1, executable: decoded.executable, actions: decoded.actions,
                                       leftFile: nil, leftFolder: nil, roots: [])
        let staged = FinderMenuSnapshot(version: 1, executable: decoded.executable, actions: decoded.actions,
                                        leftFile: left.path, leftFolder: leftFolder.path, roots: [])
        func check(_ snapshot: FinderMenuSnapshot, _ urls: [URL], _ expected: [String]) {
            let actual = snapshot.actions(for: urls).map(\.id)
            precondition(actual == expected, "Unexpected Finder menu: \(actual), expected \(expected)")
        }
        check(fresh, [], [])
        check(fresh, [right], ["selectLeft"])
        check(fresh, [rightFolder], ["selectLeftFolder"])
        check(fresh, [left, right], ["compare", "merge"])
        check(fresh, [leftFolder, rightFolder], ["compare", "sync"])
        check(fresh, [left, rightFolder], [])
        check(fresh, [left, right, rightFolder], [])
        check(fresh, [URL(string: "sftp://example.invalid/file")!], [])
        check(staged, [right], ["selectLeft", "compareStaged", "clearLeft"])
        check(staged, [rightFolder], ["selectLeftFolder", "compareStagedFolder", "clearLeftFolder"])
        check(staged, [left], ["selectLeft", "clearLeft"])
        try FileManager.default.removeItem(at: left)
        check(staged, [right], ["selectLeft"])
        check(staged, [rightFolder], ["selectLeftFolder", "compareStagedFolder", "clearLeftFolder"])
        let action = decoded.actions.first { $0.id == "compare" }!
        precondition(FinderMenuSnapshot.arguments(for: action, urls: [right, rightFolder]) ==
                     ["-cc-compare", "--", right.path, rightFolder.path])
        let clear = decoded.actions.first { $0.id == "clearLeft" }!
        precondition(FinderMenuSnapshot.arguments(for: clear, urls: [right]) == ["-cc-clear-left"])
        print("Finder menu selection, staging, and argv tests passed")
    }
}