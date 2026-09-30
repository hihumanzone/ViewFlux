; High-DPI Awareness for Windows NSIS Installer
; Prevents Windows DWM bitmap stretching/blurriness on high-DPI displays (125%, 150%, 200%, etc.)
ManifestDPIAware true

; Branded Welcome Page for Assisted Installer
!macro customWelcomePage
  !insertmacro skipPageIfUpdated
  !insertmacro MUI_PAGE_WELCOME
!macroend
