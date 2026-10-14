; Pontoon registers its notification identity (display name and icon) under
; HKCU at startup, so Windows shows its toasts; remove it on uninstall.
!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\AppUserModelId\build.pontoon.desktop"
!macroend
