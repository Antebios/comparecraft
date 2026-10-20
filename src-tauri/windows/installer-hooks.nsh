!macro NSIS_HOOK_POSTINSTALL
  ExecWait '"$INSTDIR\comparecraft.exe" -cc-install-shell' $0
  StrCmp $0 0 cc_shell_refresh_ok
  FileOpen $1 "$INSTDIR\shell-integration-install-error.txt" w
  FileWrite $1 "CompareCraft file-manager integration refresh failed with exit code $0.$\r$\n"
  FileClose $1
  Goto cc_shell_refresh_done
cc_shell_refresh_ok:
  Delete "$INSTDIR\shell-integration-install-error.txt"
cc_shell_refresh_done:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    DeleteRegKey HKCU "Software\Classes\*\shell\CompareCraft.compare"
    DeleteRegKey HKCU "Software\Classes\*\shell\CompareCraft.selectLeft"
    DeleteRegKey HKCU "Software\Classes\*\shell\CompareCraft.compareStaged"
    DeleteRegKey HKCU "Software\Classes\*\shell\CompareCraft.merge"
    DeleteRegKey HKCU "Software\Classes\*\shell\CompareCraft.sync"
    DeleteRegKey HKCU "Software\Classes\Directory\shell\CompareCraft.compare"
    DeleteRegKey HKCU "Software\Classes\Directory\shell\CompareCraft.sync"
    DeleteRegKey HKCU "Software\Classes\CLSID\{5E8A1F31-92B3-4B16-A421-724E3F8C1001}"
    DeleteRegKey HKCU "Software\Classes\CLSID\{5E8A1F32-92B3-4B16-A421-724E3F8C1002}"
    DeleteRegKey HKCU "Software\Classes\CLSID\{5E8A1F33-92B3-4B16-A421-724E3F8C1003}"
    Delete "$APPDATA\comparecraft\context-left.json"
    Delete "$APPDATA\comparecraft\shell-integration.json"
  ${EndIf}
!macroend
