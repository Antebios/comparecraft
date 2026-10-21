#include <KAbstractFileItemActionPlugin>
#include <KFileItem>
#include <KFileItemListProperties>
#include <KPluginFactory>
#include <QAction>
#include <QApplication>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QPluginLoader>
#include <QTemporaryDir>

static void write(const QString &path, const QByteArray &content) {
    QFile file(path);
    if (!file.open(QIODevice::WriteOnly) || file.write(content) != content.size()) qFatal("Could not create test fixture");
}

int main(int argc, char **argv) {
    QApplication application(argc, argv);
    if (argc != 2) qFatal("Plugin path required");
    QTemporaryDir root;
    qputenv("COMPARECRAFT_CONFIG_DIR", root.path().toUtf8());
    qunsetenv("COMPARECRAFT_CONTEXT_LEFT_FILE");
    qunsetenv("COMPARECRAFT_CONTEXT_LEFT_FOLDER");
    QJsonArray preferences;
    for (const auto &id : {"compare", "merge", "sync", "selectLeft", "compareStaged", "selectLeftFolder", "compareStagedFolder"})
        preferences.append(QJsonObject{{"id", id}, {"enabled", true}});
    write(root.filePath("shell-integration.json"), QJsonDocument(preferences).toJson());
    const auto left = root.filePath("left.txt");
    const auto right = root.filePath("right.txt");
    const auto folder = root.filePath("folder");
    const auto other = root.filePath("other folder");
    write(left, "left"); write(right, "right");
    QDir().mkdir(folder); QDir().mkdir(other);
    QPluginLoader loader(QString::fromLocal8Bit(argv[1]));
    auto *factory = qobject_cast<KPluginFactory *>(loader.instance());
    if (!factory) qFatal("Could not load native plugin: %s", qPrintable(loader.errorString()));
    auto *provider = factory->create<KAbstractFileItemActionPlugin>();
    if (!provider) qFatal("Could not create action provider");
    auto check = [&](const QStringList &paths, const QStringList &expected) {
        KFileItemList files;
        for (const auto &path : paths) files.append(KFileItem(QUrl::fromLocalFile(path)));
        const auto actions = provider->actions(KFileItemListProperties(files), nullptr);
        QStringList labels;
        for (auto *action : actions) { labels.append(action->text()); delete action; }
        if (labels != expected) qFatal("Menu mismatch: %s", qPrintable(labels.join(", ")));
    };
    check({}, {});
    check({right}, {"Select Left File for Compare"});
    check({folder}, {"Select Left Folder for Compare"});
    check({left, right}, {"Compare", "Merge"});
    check({folder, other}, {"Compare", "Sync"});
    check({left, folder}, {});
    check({left, right, folder}, {});
    write(root.filePath("context-left.json"), QJsonDocument(QJsonArray{left}).toJson().trimmed().mid(1).chopped(1));
    check({right}, {"Select Left File for Compare", "Compare to Selected Left File", "Clear Selected Left File"});
    QFile::remove(left);
    check({right}, {"Select Left File for Compare"});
    delete provider;
    return 0;
}