#include <thunarx/thunarx.h>

extern unsigned int comparecraft_menu_mask(size_t count, const char *const *paths);
extern const char *comparecraft_menu_text(size_t index, size_t field);
extern int comparecraft_menu_activate(size_t index, size_t count, const char *const *paths);

typedef struct { GObject parent; } CompareCraftProvider;
typedef struct { GObjectClass parent; } CompareCraftProviderClass;
static GType provider_type;

static void activate(ThunarxMenuItem *item, gpointer unused) {
    (void) unused;
    char **paths = g_object_get_data(G_OBJECT(item), "comparecraft-paths");
    size_t index = GPOINTER_TO_UINT(g_object_get_data(G_OBJECT(item), "comparecraft-index"));
    if (comparecraft_menu_activate(index, g_strv_length(paths), (const char *const *) paths) != 0)
        g_warning("CompareCraft: selection changed or application could not be launched; reopen the menu");
}

static GList *file_items(ThunarxMenuProvider *provider, GtkWidget *window, GList *files) {
    (void) provider;
    (void) window;
    guint count = g_list_length(files);
    if (count == 0 || count > 2) return NULL;
    char **paths = g_new0(char *, count + 1);
    guint offset = 0;
    for (GList *selected = files; selected; selected = selected->next, offset++) {
        char *uri = thunarx_file_info_get_uri(selected->data);
        paths[offset] = g_filename_from_uri(uri, NULL, NULL);
        g_free(uri);
        if (!paths[offset]) { g_strfreev(paths); return NULL; }
    }
    unsigned int mask = comparecraft_menu_mask(count, (const char *const *) paths);
    GList *items = NULL;
    for (size_t index = 0; mask; index++, mask >>= 1) {
        if (!(mask & 1)) continue;
        const char *icon = comparecraft_menu_text(index, 2);
        GdkScreen *screen = gdk_screen_get_default();
        GtkIconTheme *theme = screen ? gtk_icon_theme_get_for_screen(screen) : NULL;
        if (!theme || !gtk_icon_theme_has_icon(theme, icon)) icon = "comparecraft";
        ThunarxMenuItem *item = thunarx_menu_item_new(comparecraft_menu_text(index, 0),
            comparecraft_menu_text(index, 1), "CompareCraft", icon);
        g_object_set_data_full(G_OBJECT(item), "comparecraft-paths", g_strdupv(paths), (GDestroyNotify) g_strfreev);
        g_object_set_data(G_OBJECT(item), "comparecraft-index", GUINT_TO_POINTER(index));
        g_signal_connect(item, "activate", G_CALLBACK(activate), NULL);
        items = g_list_append(items, item);
    }
    g_strfreev(paths);
    return items;
}

static void provider_interface(gpointer interface, gpointer data) {
    (void) data;
    ((ThunarxMenuProviderIface *) interface)->get_file_menu_items = file_items;
}

G_MODULE_EXPORT void thunar_extension_initialize(ThunarxProviderPlugin *plugin) {
    const GTypeInfo info = { sizeof(CompareCraftProviderClass), NULL, NULL, NULL, NULL,
        NULL, sizeof(CompareCraftProvider), 0, NULL, NULL };
    const GInterfaceInfo interface = { provider_interface, NULL, NULL };
    provider_type = thunarx_provider_plugin_register_type(plugin, G_TYPE_OBJECT,
        "CompareCraftProvider", &info, 0);
    thunarx_provider_plugin_add_interface(plugin, provider_type, THUNARX_TYPE_MENU_PROVIDER, &interface);
    thunarx_provider_plugin_set_resident(plugin, TRUE);
}

G_MODULE_EXPORT void thunar_extension_shutdown(void) {}

G_MODULE_EXPORT void thunar_extension_list_types(const GType **types, int *count) {
    *types = &provider_type;
    *count = 1;
}