; electron-builder custom NSIS include (nsis.include in electron-builder.yml). Only hooks the generated script; the
; templates themselves live in node_modules/app-builder-lib/templates/nsis.

; Run-after-install starts the executable itself, never the Start Menu shortcut.
;
; electron-builder's default sets $launchLink to the freshly written "Zeraix.lnk" so that the launched process inherits
; the shortcut's AppUserModelID. That makes the wizard's "Run Zeraix" (and the silent --force-run / updater path) depend
; on the shell resolving a shortcut created milliseconds earlier -- link tracking, the app resolver cache, the AUMID
; property store -- and on 2026-09-04 that failed on a Windows 11 25H2 machine with the shell's "Unspecified error"
; dialog titled with the .lnk path, right on the finish page, while the same shortcut opened fine seconds later.
; The app does not need the shortcut for its identity: electron/appIdentity.mjs sets the same AppUserModelID itself
; (app.setAppUserModelId), so taskbar grouping and toasts are unaffected. customInstall runs after $launchLink is set
; and before it is used, and ExecShellAsUser still launches unelevated.
!macro customInstall
  StrCpy $launchLink "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
!macroend
