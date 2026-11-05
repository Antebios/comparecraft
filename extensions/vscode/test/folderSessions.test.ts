import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { parseFolderSession, sessionSpec } from "../src/folderSessions";

test("folder session state round trips without editor buffers or desktop storage", () => {
  const session = parseFolderSession({
    id: "one", name: "Project", kind: "folder", paths: [path.resolve("left"), path.resolve("right")],
    options: { comparisonPresets: { activePresetId: "builtin:all:rules", pinnedPresetIds: [] } },
    modified: 123, saved: true, locked: true
  });
  const spec = sessionSpec(session);
  assert.equal(spec.kind, "folder");
  assert.equal(spec.sessionId, "one");
  assert.equal(spec.sessionName, "Project");
  assert.equal(spec.locked, true);
  assert.deepEqual(spec.options, session.options);
  for (const invalid of [
    { ...session, kind: "text" }, { ...session, id: "" }, { ...session, name: " " },
    { ...session, paths: ["relative", session.paths[1]] }, { ...session, saved: "yes" },
    { ...session, modified: Infinity }, { ...session, options: [] }
  ]) assert.throws(() => parseFolderSession(invalid));
});
