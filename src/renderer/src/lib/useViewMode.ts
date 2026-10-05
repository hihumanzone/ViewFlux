import { useCallback } from 'react'
import { useApp } from '../state/AppContext'

export type ViewMode = 'grid' | 'list'

export function useViewMode(sectionId: string): [ViewMode, (mode: ViewMode) => void] {
  const { settings, saveSettings } = useApp()
  const currentMode: ViewMode =
    settings.viewModes?.[sectionId] ?? settings.defaultViewMode ?? 'grid'

  const setViewMode = useCallback(
    (mode: ViewMode) => {
      const nextViewModes = {
        ...(settings.viewModes ?? {}),
        [sectionId]: mode
      }
      void saveSettings({
        ...settings,
        viewModes: nextViewModes
      })
    },
    [settings, saveSettings, sectionId]
  )

  return [currentMode, setViewMode]
}
