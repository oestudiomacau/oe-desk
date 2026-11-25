Unicode true
Name "OE DESK"
OutFile "${INSTALLER_FILE}"
InstallDir "$LOCALAPPDATA\Programs\OE DESK"
RequestExecutionLevel user
SetCompressor /SOLID lzma
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "OE DESK"
VIAddVersionKey "FileDescription" "OE DESK Windows Installer"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"

Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "OE DESK"
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File /r "${APP_STAGE}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall OE DESK.exe"
  CreateShortCut "$SMPROGRAMS\OE DESK.lnk" "$INSTDIR\OE DESK.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OEDesk" "DisplayName" "OE DESK"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OEDesk" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OEDesk" "DisplayIcon" "$INSTDIR\OE DESK.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OEDesk" "UninstallString" '"$INSTDIR\Uninstall OE DESK.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OEDesk" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OEDesk" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  StrCmp "$INSTDIR" "$LOCALAPPDATA\Programs\OE DESK" 0 unexpectedPath
  Delete "$SMPROGRAMS\OE DESK.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\OEDesk"
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  Delete "$INSTDIR\*.pak"
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\*.bin"
  Delete "$INSTDIR\*.dat"
  Delete "$INSTDIR\*.json"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\LICENSES.chromium.html"
  Delete "$INSTDIR\version"
  Delete "$INSTDIR\OE DESK.exe"
  Delete "$INSTDIR\Uninstall OE DESK.exe"
  RMDir "$INSTDIR"
  Goto finished
  unexpectedPath:
    Abort "The uninstaller must run from the original OE DESK installation folder."
  finished:
SectionEnd
