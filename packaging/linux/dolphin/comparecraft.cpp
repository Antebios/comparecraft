#include <KAbstractFileItemActionPlugin>
#include <KFileItem>
#include <KFileItemListProperties>
#include <KPluginFactory>
#include <QAction>
#include <QIcon>
#include <QWidget>

extern "C" {
unsigned int comparecraft_menu_mask(size_t count, const char *const *paths);
const char *comparecraft_menu_text(size_t index, size_t field);
int comparecraft_menu_activate(size_t index, size_t count, const char *const *paths);
}

class CompareCraftActions : public KAbstractFileItemActionPlugin {
    Q_OBJECT
public:
    explicit CompareCraftActions(QObject *parent, const QVariantList &arguments)
        : KAbstractFileItemActionPlugin(parent) { Q_UNUSED(arguments); }

    QList<QAction *> actions(const KFileItemListProperties &selection, QWidget *parent) override {
        const auto items = selection.items();
        if (items.isEmpty() || items.size() > 2) return {};
        QList<QByteArray> paths;
        for (const auto &item : items) {
            if (!item.url().isLocalFile()) return {};
            paths.append(item.url().toLocalFile().toUtf8());
        }
        QList<const char *> pointers;
        for (const auto &path : paths) pointers.append(path.constData());
        unsigned int mask = comparecraft_menu_mask(pointers.size(), pointers.constData());
        QList<QAction *> result;
        for (size_t index = 0; mask; index++, mask >>= 1) {
            if (!(mask & 1)) continue;
            const auto label = QString::fromUtf8(comparecraft_menu_text(index, 1));
            const auto icon = QIcon::fromTheme(QString::fromUtf8(comparecraft_menu_text(index, 2)), QIcon::fromTheme("comparecraft"));
            auto *action = new QAction(icon, label, parent);
            connect(action, &QAction::triggered, this, [this, index, paths]() {
                QList<const char *> selected;
                for (const auto &path : paths) selected.append(path.constData());
                if (comparecraft_menu_activate(index, selected.size(), selected.constData()) != 0)
                    Q_EMIT error(QStringLiteral("CompareCraft: selection changed or application could not be launched; reopen the menu"));
            });
            result.append(action);
        }
        return result;
    }
};

K_PLUGIN_CLASS_WITH_JSON(CompareCraftActions, "comparecraft.json")
#include "comparecraft.moc"