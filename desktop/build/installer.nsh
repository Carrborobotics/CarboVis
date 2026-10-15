; Extra shortcut for the driver station: opens straight into the match view, sized to sit above the FRC Driver Station.
; Also removes the shortcuts the old browser-based installer (install.ps1) made.
!macro customInstall
  CreateShortCut "$DESKTOP\CarboVis Match View.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--matchview" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  CreateShortCut "$SMPROGRAMS\CarboVis Match View.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--matchview" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  Delete "$DESKTOP\7763 Match Logs.lnk"
  Delete "$DESKTOP\7763 Match View.lnk"
  Delete "$SMPROGRAMS\7763 Match Logs.lnk"
  Delete "$SMPROGRAMS\7763 Match View.lnk"
!macroend

!macro customUnInstall
  Delete "$DESKTOP\CarboVis Match View.lnk"
  Delete "$SMPROGRAMS\CarboVis Match View.lnk"
!macroend
