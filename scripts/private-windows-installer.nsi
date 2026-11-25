Unicode true
Name "OE DESK 私有版"
OutFile "${INSTALLER_FILE}"
RequestExecutionLevel user
SetCompress off
ShowInstDetails nevershow

!include "nsDialogs.nsh"
!include "StrFunc.nsh"
${StrStr}

Var PasswordField
Var Password

Page custom PasswordPage ReadPassword
Page instfiles

Function PasswordPage
  nsDialogs::Create 1018
  Pop $0
  StrCmp $0 "error" 0 +2
  Abort
  ${NSD_CreateLabel} 0 8u 100% 23u "输入私有安装密码，以导入随包附带的知识库和模型配置。"
  Pop $0
  ${NSD_CreatePassword} 0 36u 100% 14u ""
  Pop $PasswordField
  nsDialogs::Show
FunctionEnd

Function ReadPassword
  ${NSD_GetText} $PasswordField $Password
  StrLen $0 $Password
  StrCmp $0 24 0 invalid
  StrCpy $0 0
  validate:
    StrCpy $1 $Password 1 $0
    ${StrStr} $2 "0123456789abcdef" $1
    StrCmp $2 "" invalid
    IntOp $0 $0 + 1
    IntCmp $0 24 valid validate
  invalid:
    MessageBox MB_OK|MB_ICONEXCLAMATION "请输入完整的 24 位安装密码。"
    Abort
  valid:
FunctionEnd

Section
  SetShellVarContext current
  IfSilent silentNotSupported
  IfFileExists "$APPDATA\OE DESK\workbench\*" existingProfile
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=OEDeskProgram.exe "${PUBLIC_INSTALLER}"
  File /oname=Profile.7z "${ENCRYPTED_PROFILE}"
  File /oname=7za.exe "${ARCHIVER}"
  File /oname=7Zip-License.txt "${ARCHIVER_LICENSE}"
  File /oname=7Zip-Copying.txt "${ARCHIVER_COPYING}"

  nsExec::Exec '"$PLUGINSDIR\7za.exe" x "$PLUGINSDIR\Profile.7z" -o"$PLUGINSDIR\payload" -p$Password -y'
  Pop $0
  StrCpy $Password ""
  StrCmp $0 "0" 0 passwordError
  IfFileExists "$PLUGINSDIR\payload\workbench\.env" 0 passwordError
  IfFileExists "$APPDATA\OE DESK\workbench\*" existingProfile

  ExecWait '"$PLUGINSDIR\OEDeskProgram.exe" /S' $0
  StrCmp $0 "0" 0 installError
  IfFileExists "$LOCALAPPDATA\Programs\OE DESK\OE DESK.exe" 0 installError
  IfFileExists "$APPDATA\OE DESK\workbench\*" existingProfile
  CreateDirectory "$APPDATA\OE DESK"
  RMDir "$APPDATA\OE DESK\workbench"
  ClearErrors
  Rename "$PLUGINSDIR\payload\workbench" "$APPDATA\OE DESK\workbench"
  IfErrors installError
  SetOutPath "$LOCALAPPDATA\Programs\OE DESK"
  CreateShortCut "$DESKTOP\OE DESK.lnk" "$LOCALAPPDATA\Programs\OE DESK\OE DESK.exe"
  MessageBox MB_OK "OE DESK 已安装。请双击桌面的 OE DESK 图标打开。"
  Goto done

  silentNotSupported:
    SetErrorLevel 1
    Abort
  existingProfile:
    SetErrorLevel 1
    MessageBox MB_OK|MB_ICONEXCLAMATION "此 Windows 用户已有 OE DESK 数据。请先保留原有数据，再进行迁移。"
    Abort
  passwordError:
    SetErrorLevel 1
    MessageBox MB_OK|MB_ICONSTOP "密码不正确或数据文件损坏。请关闭安装包后重试。"
    Abort
  installError:
    SetErrorLevel 1
    MessageBox MB_OK|MB_ICONSTOP "安装或迁移数据失败。请关闭 OE DESK 后重试。"
    Abort
  done:
SectionEnd
