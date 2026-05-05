; build/installer.nsh
;
; electron-builder picks this up via "build.nsis.include" in package.json.
; Only thing we need from NSIS is to clean Claude Code's hook config
; before our exe vanishes from disk — otherwise the user's
; ~/.claude/settings.json keeps pointing at a vibelog.exe that no longer
; exists, every Claude Code tool call hangs on the missing daemon, and
; the next reinstall has to find a way to repair the damage.
;
; The macro runs while $INSTDIR\vibelog.exe is still present, but BEFORE
; the file-deletion phase. ExecWait blocks until vibelog.exe exits so we
; don't race the uninstall step.

!macro customUnInstall
  DetailPrint "Removing Claude Code hooks..."
  ExecWait '"$INSTDIR\vibelog.exe" --uninstall-hooks' $0
  DetailPrint "Hook cleanup exit code: $0"
!macroend

; customInstall is intentionally not used — the app self-heals on first
; launch (see main.js, app.whenReady block, "self-heal" comment). Doing
; it from NSIS would require running the .exe synchronously during
; install, which slows the installer perceptibly without a real win.
