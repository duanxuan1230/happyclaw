import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type SyntheticEvent,
} from 'react';

/**
 * What the phone dock tells the controls it hosts (the model picker comes in
 * from ChatView as an element, so this goes by context, not props).
 */
export interface ComposerDockApi {
  /** The resting phone pill: a control shows its compact form. */
  compact: boolean;
  /**
   * A sheet or menu a dock control owns opened or closed. Call it from the
   * open-change handler, not an effect: the card must already count it as
   * open when focus moves into the overlay (cindy's composerCardActive).
   */
  setOverlayOpen: (id: string, open: boolean) => void;
}

export const ComposerDockContext = createContext<ComposerDockApi | null>(null);

/** The composer around this control; null outside one. */
export function useComposerDock(): ComposerDockApi | null {
  return useContext(ComposerDockContext);
}

/**
 * Report one overlay's open state to the composer around it: call the
 * returned function from the overlay's open-change handler. An overlay
 * unmounted while open counts as closed.
 */
export function useDockOverlay(id: string): (open: boolean) => void {
  const dock = useComposerDock();
  const dockRef = useRef(dock);
  dockRef.current = dock;
  useEffect(() => () => dockRef.current?.setOverlayOpen(id, false), [id]);
  return useCallback(
    (open: boolean) => dockRef.current?.setOverlayOpen(id, open),
    [id],
  );
}

/**
 * onMouseDown for a dock control that opens an overlay: the press keeps the
 * editor's focus. iOS never focuses a tapped button, so without this the
 * editor blurs (relatedTarget null) and the card folds into the pill before
 * the click arrives, which then lands on whatever moved under the finger.
 */
export function keepEditorFocus(event: SyntheticEvent): void {
  event.preventDefault();
}
