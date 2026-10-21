from gi.repository import Gio
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

import gi

gi.require_version("Nautilus", "4.1")


library = str(Path(sys.argv.pop(1)).resolve())
source = Path("packaging/linux/nautilus/comparecraft.py").read_text().replace(
    '"@COMPARECRAFT_MENU_LIBRARY@"', repr(library)
)
namespace = {}
exec(compile(source, "comparecraft.py", "exec"), namespace)


class SelectedItem:
    def __init__(self, path):
        self.location = Gio.File.new_for_path(str(path))

    def get_location(self):
        return self.location


class NativeMenusTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.old_environment = {name: os.environ.get(name) for name in (
            "COMPARECRAFT_CONFIG_DIR", "COMPARECRAFT_CONTEXT_LEFT_FILE", "COMPARECRAFT_CONTEXT_LEFT_FOLDER"
        )}
        os.environ["COMPARECRAFT_CONFIG_DIR"] = str(self.root)
        os.environ.pop("COMPARECRAFT_CONTEXT_LEFT_FILE", None)
        os.environ.pop("COMPARECRAFT_CONTEXT_LEFT_FOLDER", None)
        self.preferences = ["compare", "selectLeft", "compareStaged",
                            "selectLeftFolder", "compareStagedFolder", "merge", "sync"]
        self.save_preferences()
        self.left = self.root / "left file 'quoted'.txt"
        self.right = self.root / "right file.txt"
        self.left.write_text("left")
        self.right.write_text("right")
        self.left_folder = self.root / "left folder"
        self.right_folder = self.root / "right folder"
        self.left_folder.mkdir()
        self.right_folder.mkdir()
        self.provider = namespace["CompareCraftMenu"]()
        self.assertIsNotNone(self.provider.library)

    def tearDown(self):
        for name, value in self.old_environment.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        self.temporary.cleanup()

    def save_preferences(self):
        (self.root / "shell-integration.json").write_text(json.dumps([
            {"id": identifier, "enabled": True} for identifier in self.preferences
        ]))

    def labels(self, *paths):
        items = self.provider.get_file_items(
            [SelectedItem(path) for path in paths])
        return [item.get_property("label") for item in items]

    def test_fresh_type_and_count_filtering(self):
        self.assertEqual(self.labels(), [])
        self.assertEqual(self.labels(self.right), [
                         "Select Left File for Compare"])
        self.assertEqual(self.labels(self.right_folder), [
                         "Select Left Folder for Compare"])
        self.assertEqual(self.labels(self.left, self.right),
                         ["Compare", "Merge"])
        self.assertEqual(self.labels(self.left_folder,
                         self.right_folder), ["Compare", "Sync"])
        self.assertEqual(self.labels(self.left, self.right_folder), [])
        self.assertEqual(self.labels(
            self.left, self.right, self.right_folder), [])

    def test_staged_menus_refresh_without_provider_restart(self):
        (self.root / "context-left.json").write_text(json.dumps(str(self.left)))
        (self.root / "context-left-folder.json").write_text(json.dumps(str(self.left_folder)))
        self.assertEqual(self.labels(self.right), [
                         "Select Left File for Compare", "Compare to Selected Left File", "Clear Selected Left File"])
        self.assertEqual(self.labels(self.right_folder), [
                         "Select Left Folder for Compare", "Compare to Selected Left Folder", "Clear Selected Left Folder"])
        self.assertEqual(self.labels(self.left), [
                         "Select Left File for Compare", "Clear Selected Left File"])
        self.left.unlink()
        self.assertEqual(self.labels(self.right), [
                         "Select Left File for Compare"])
        self.assertIn("Compare to Selected Left Folder",
                      self.labels(self.right_folder))

    def test_preferences_invalid_state_and_remote_items(self):
        self.preferences = ["selectLeft"]
        self.save_preferences()
        self.assertEqual(self.labels(self.right_folder), [])
        (self.root / "context-left.json").write_text("corrupt")
        self.assertEqual(self.labels(self.right), [
                         "Select Left File for Compare"])
        remote = SelectedItem(self.right)
        remote.location = Gio.File.new_for_uri(
            "sftp://example.invalid/file.txt")
        self.assertEqual(self.provider.get_file_items([remote]), [])
        item = self.provider.get_file_items([SelectedItem(self.right)])[0]
        if item.find_property("icon") is not None:
            self.assertTrue(item.get_property("icon"))


if __name__ == "__main__":
    unittest.main()
