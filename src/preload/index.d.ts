import type { AppApi } from '../shared/types'

declare global {
  interface WindowControlsOverlayGeometryChangeEvent extends Event {
    readonly titlebarAreaRect: DOMRect
    readonly visible: boolean
  }

  interface WindowControlsOverlay extends EventTarget {
    readonly visible: boolean
    getTitlebarAreaRect(): DOMRect
    addEventListener(
      type: 'geometrychange',
      listener: (this: WindowControlsOverlay, ev: WindowControlsOverlayGeometryChangeEvent) => any,
      options?: boolean | AddEventListenerOptions
    ): void
    removeEventListener(
      type: 'geometrychange',
      listener: (this: WindowControlsOverlay, ev: WindowControlsOverlayGeometryChangeEvent) => any,
      options?: boolean | EventListenerOptions
    ): void
  }

  interface Navigator {
    readonly windowControlsOverlay?: WindowControlsOverlay
  }

  interface Window {
    api: AppApi
  }
}

export {}
