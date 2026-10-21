#include <glib/gstdio.h>
#include "../packaging/linux/thunar/comparecraft.c"

typedef struct { GObject parent; } TestFile;
typedef struct { GObjectClass parent; } TestFileClass;

static char *test_uri(ThunarxFileInfo *file) {
    return g_strdup(g_object_get_data(G_OBJECT(file), "uri"));
}

static void file_interface(gpointer interface, gpointer data) {
    (void) data;
    ((ThunarxFileInfoIface *) interface)->get_uri = test_uri;
}

G_DEFINE_TYPE_WITH_CODE(TestFile, test_file, G_TYPE_OBJECT,
    G_IMPLEMENT_INTERFACE(THUNARX_TYPE_FILE_INFO, file_interface))
static void test_file_class_init(TestFileClass *type) { (void) type; }
static void test_file_init(TestFile *file) { (void) file; }

static GObject *selected(const char *path) {
    GObject *file = g_object_new(test_file_get_type(), NULL);
    g_object_set_data_full(file, "uri", g_filename_to_uri(path, NULL, NULL), g_free);
    return file;
}

static void check(GList *files, guint count, const char *first) {
    GList *items = file_items(NULL, NULL, files);
    g_assert_cmpuint(g_list_length(items), ==, count);
    if (first) {
        char *label = NULL;
        g_object_get(items->data, "label", &label, NULL);
        g_assert_cmpstr(label, ==, first);
        g_free(label);
    }
    if (items) thunarx_menu_item_list_free(items);
}

int main(void) {
    char *root = g_dir_make_tmp("comparecraft-thunar-XXXXXX", NULL);
    g_assert_nonnull(root);
    g_setenv("COMPARECRAFT_CONFIG_DIR", root, TRUE);
    g_unsetenv("COMPARECRAFT_CONTEXT_LEFT_FILE");
    g_unsetenv("COMPARECRAFT_CONTEXT_LEFT_FOLDER");
    char *preferences = g_build_filename(root, "shell-integration.json", NULL);
    g_file_set_contents(preferences, "[{\"id\":\"compare\",\"enabled\":true},{\"id\":\"merge\",\"enabled\":true},{\"id\":\"sync\",\"enabled\":true},{\"id\":\"selectLeft\",\"enabled\":true},{\"id\":\"selectLeftFolder\",\"enabled\":true},{\"id\":\"compareStagedFolder\",\"enabled\":true}]", -1, NULL);
    char *left = g_build_filename(root, "left.txt", NULL);
    char *right = g_build_filename(root, "right.txt", NULL);
    char *folder = g_build_filename(root, "folder", NULL);
    char *other_folder = g_build_filename(root, "other folder", NULL);
    g_file_set_contents(left, "left", -1, NULL);
    g_file_set_contents(right, "right", -1, NULL);
    g_mkdir(folder, 0700);
    g_mkdir(other_folder, 0700);
    GList *files = g_list_append(NULL, selected(left));
    check(NULL, 0, NULL);
    check(files, 1, "Select Left File for Compare");
    files = g_list_append(files, selected(right));
    check(files, 2, "Compare");
    g_list_free_full(files, g_object_unref);
    files = g_list_append(NULL, selected(folder));
    check(files, 1, "Select Left Folder for Compare");
    char *state = g_build_filename(root, "context-left-folder.json", NULL);
    char *value = g_strdup_printf("\"%s\"", other_folder);
    g_file_set_contents(state, value, -1, NULL);
    check(files, 3, "Select Left Folder for Compare");
    files = g_list_append(files, selected(other_folder));
    check(files, 2, "Compare");
    g_list_free_full(files, g_object_unref);
    files = g_list_append(g_list_append(NULL, selected(left)), selected(folder));
    check(files, 0, NULL);
    g_list_free_full(files, g_object_unref);
    g_remove(left); g_remove(right); g_remove(state); g_remove(preferences);
    g_rmdir(folder); g_rmdir(other_folder); g_rmdir(root);
    g_free(value); g_free(state); g_free(preferences); g_free(left); g_free(right);
    g_free(folder); g_free(other_folder); g_free(root);
    g_print("Thunar native selection and staged-state tests passed\n");
    return 0;
}