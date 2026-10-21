cmake_minimum_required(VERSION 3.20)
project(comparecraft_dolphin LANGUAGES CXX)
set(CMAKE_AUTOMOC ON)
set(CMAKE_CXX_STANDARD 17)
find_package(Qt6 REQUIRED COMPONENTS Widgets)
find_package(KF6KIO REQUIRED)
find_package(KF6CoreAddons REQUIRED)
add_library(comparecraft-dolphin MODULE comparecraft.cpp)
target_link_libraries(comparecraft-dolphin PRIVATE KF6::KIOWidgets KF6::CoreAddons "${COMPARECRAFT_MENU_LIBRARY}")
set_target_properties(comparecraft-dolphin PROPERTIES
    PREFIX ""
    BUILD_WITH_INSTALL_RPATH TRUE
    BUILD_RPATH "${COMPARECRAFT_MENU_DIRECTORY}"
    INSTALL_RPATH "$ORIGIN/../../../../comparecraft;$ORIGIN/../debug;$ORIGIN/../release")
install(TARGETS comparecraft-dolphin DESTINATION lib/qt6/plugins/kf6/kfileitemaction)
include(CTest)
if(BUILD_TESTING)
    add_executable(test-dolphin-menu ../../../tests/shell_menus_dolphin.cpp)
    target_link_libraries(test-dolphin-menu PRIVATE KF6::KIOWidgets KF6::CoreAddons)
    add_test(NAME dolphin-selection-menu COMMAND test-dolphin-menu $<TARGET_FILE:comparecraft-dolphin>)
    set_tests_properties(dolphin-selection-menu PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen")
endif()