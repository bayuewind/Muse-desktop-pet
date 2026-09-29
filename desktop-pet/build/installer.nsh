; Keep electron-builder's tested install/uninstall flow; customize only Finish.
; Installer skips eager desktop-link creation. Uninstaller retains its normal
; shortcut cleanup because this define is intentionally installer-only.
!ifndef BUILD_UNINSTALLER
  !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
    !define DO_NOT_CREATE_DESKTOP_SHORTCUT
  !endif

  !macro customFinishPage
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_TEXT "启动 Muse 桌宠"
    !define MUI_FINISHPAGE_RUN_FUNCTION MuseFinishRun
    !define MUI_FINISHPAGE_SHOWREADME
    !define MUI_FINISHPAGE_SHOWREADME_TEXT "创建桌面快捷方式"
    !define MUI_FINISHPAGE_SHOWREADME_FUNCTION MuseFinishShortcut
    !insertmacro MUI_PAGE_FINISH
    Function MuseFinishRun
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    Function MuseFinishShortcut
    ; MUI calls this function only if its checkbox is checked on Finish.
    ; Respect the existing noninteractive --no-desktop-shortcut convention.
    ${ifNot} ${isNoDesktopShortcut}
      CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
      System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
    ${endif}
    FunctionEnd
  !macroend
!endif
