import ctypes
import importlib
import os

import gi
from gi.repository import GObject

gi.require_version("Nautilus", "4.1")
Nautilus = importlib.import_module("gi.repository.Nautilus")


class CompareCraftMenu(GObject.GObject, Nautilus.MenuProvider):
    def __init__(self):
        super().__init__()
        self.library = None
        try:
            self.library = ctypes.CDLL("@COMPARECRAFT_MENU_LIBRARY@")
            arguments = [ctypes.c_size_t, ctypes.POINTER(ctypes.c_char_p)]
            self.library.comparecraft_menu_mask.argtypes = arguments
            self.library.comparecraft_menu_mask.restype = ctypes.c_uint32
            self.library.comparecraft_menu_text.argtypes = [
                ctypes.c_size_t, ctypes.c_size_t
            ]
            self.library.comparecraft_menu_text.restype = ctypes.c_char_p
            self.library.comparecraft_menu_activate.argtypes = [
                ctypes.c_size_t
            ] + arguments
            self.library.comparecraft_menu_activate.restype = ctypes.c_int
        except OSError:
            self.library = None

    def get_file_items(self, files):
        if self.library is None or not 1 <= len(files) <= 2:
            return []
        paths = []
        for selected in files:
            location = selected.get_location()
            if location is None or not location.is_native():
                return []
            path = location.get_path()
            if path is None:
                return []
            paths.append(os.fsencode(path))
        arguments = (ctypes.c_char_p * len(paths))(*paths)
        mask = self.library.comparecraft_menu_mask(len(paths), arguments)
        items = []
        index = 0
        while mask:
            if mask & 1:
                identifier = self.library.comparecraft_menu_text(
                    index, 0
                ).decode()
                label = self.library.comparecraft_menu_text(index, 1).decode()
                item = Nautilus.MenuItem(
                    name="CompareCraft::" + identifier, label=label
                )
                if item.find_property("icon") is not None:
                    icon = self.library.comparecraft_menu_text(
                        index, 2
                    ).decode()
                    item.set_property("icon", icon)
                item.connect("activate", self.activate, index, paths)
                items.append(item)
            mask >>= 1
            index += 1
        return items

    def activate(self, item, index, paths):
        arguments = (ctypes.c_char_p * len(paths))(*paths)
        result = self.library.comparecraft_menu_activate(
            index, len(paths), arguments
        )
        if result != 0:
            print(
                "CompareCraft: selection changed or application could not "
                "be launched; reopen the menu"
            )
