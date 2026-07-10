/**
 * Bridges a sidebar session drag (HTML5) into the SAME zone overlay a tab drag
 * uses — identical radial targeting (`subZonePosition`: elliptical center,
 * angle-picked edges), identical sheet visuals:
 *
 *   - CENTER region → the existing "link to chat" affordance (ChatDropOverlay
 *     + onDropSession). The bridge never claims it; the composer is center by
 *     definition, so linking/attaching is never shadowed by a split target.
 *   - EDGE region → tile drop: releasing opens the session as a tile docked on
 *     that edge of that zone.
 *
 * Fully self-contained on native DnD: a session drag is DETECTED from
 * `dataTransfer.types` during dragover (readable mid-drag, unlike values) and
 * the payload is READ from the drop event itself — no store handshake with the
 * drag source, so nothing can desync. A watchdog clears the overlay shortly
 * after drag events stop, so an aborted drag can never strand it.
 *
 * HOSTILE-LIBRARY ARMOR — two app-wide DnD managers treat any native drag they
 * didn't start as an enemy, and both attack at the window level:
 *
 *   - react-dnd's HTML5Backend (mounted for the file tree, app-lifetime)
 *     preventDefaults foreign dragstarts (killing the drag at birth) and
 *     forces `dropEffect='none'` on every window-bubbled dragover (killing the
 *     drop: no drop event, snap-back animation, dragend 'none').
 *   - dnd-kit's pointer sensor attaches a window `dragstart → preventDefault`
 *     on activator pointerdown; a missed pointerup leaks it forever.
 *
 * Both are neutralized per-event from capture phase (which runs before either):
 * dragstart's preventDefault is defused for `data-native-drag` sources, and
 * dragover's dropEffect is locked to 'copy' via a shadowing own-property so
 * later bubble-phase writes can't reach the internal slot.
 */

import { useEffect } from 'react'

import { snapshotZones, subZonePosition } from '@/components/pane-shell/tree/renderer/drag-session'
import { $dropHint, $treeDragging, revealTreePane, SESSION_TILE_DRAG } from '@/components/pane-shell/tree/store'
import type { EngineZone } from '@/components/pane-shell/tree/zones-engine'
import { openSessionTile, type SplitDir } from '@/store/session-states'

import { dragHasSession, readSessionDrag, type SessionDragPayload } from './composer/inline-refs'

/** Drag events repeat continuously while a drag is alive; silence for this
 *  long means it ended, however it ended. */
const WATCHDOG_MS = 1_200

/** Set the drop effect through the native setter, then shadow the property so
 *  later handlers on this event (react-dnd's window-bubble `dropEffect='none'`)
 *  write into a no-op instead of the internal slot Chromium actually reads. */
function lockDropEffect(transfer: DataTransfer | null) {
  if (!transfer || Object.prototype.hasOwnProperty.call(transfer, 'dropEffect')) {
    return
  }

  transfer.dropEffect = 'copy'
  Object.defineProperty(transfer, 'dropEffect', {
    configurable: true,
    get: () => 'copy',
    set: () => {}
  })
}

interface SplitTarget {
  anchor: string
  payload: SessionDragPayload
  pos: SplitDir
}

export function SessionTileDropBridge() {
  useEffect(() => {
    let watchdog = 0
    // Zone rects are stable while dragging (the layout never restructures
    // mid-drag) — snapshot per drag, lazily.
    let zones: EngineZone[] | null = null
    // Payload captured at dragstart (from the source's data attributes) so the
    // dragend fallback can commit even when the browser never fires `drop`.
    let currentPayload: SessionDragPayload | null = null
    let lastSplitTarget: null | SplitTarget = null
    let committed = false

    const active = () => $treeDragging.get() === SESSION_TILE_DRAG

    const clear = () => {
      window.clearTimeout(watchdog)
      zones = null
      currentPayload = null
      lastSplitTarget = null
      committed = false

      if (active()) {
        $treeDragging.set(null)
        $dropHint.set(null)
      }
    }

    const arm = () => {
      window.clearTimeout(watchdog)
      watchdog = window.setTimeout(clear, WATCHDOG_MS)
    }

    const elementsAt = (x: number, y: number) =>
      document.elementsFromPoint(x, y).filter((el): el is HTMLElement => el instanceof HTMLElement)

    // The layout zone is the actual split target. The chat surface (workspace
    // or a tile) only tells us which session pane should anchor the new tile.
    const groupAt = (elements: HTMLElement[]): HTMLElement | null =>
      elements.map(el => el.closest<HTMLElement>('[data-tree-group]')).find(Boolean) ?? null

    const surfaceAt = (elements: HTMLElement[]): HTMLElement | null =>
      elements.map(el => el.closest<HTMLElement>('[data-session-anchor]')).find(Boolean) ?? null

    const payloadFromSource = (target: EventTarget | null): SessionDragPayload | null => {
      const source = target instanceof HTMLElement ? target.closest<HTMLElement>('[data-native-drag]') : null
      const id = source?.dataset.sessionDragId

      return id
        ? {
            id,
            profile: source.dataset.sessionDragProfile || 'default',
            title: source.dataset.sessionDragTitle || ''
          }
        : null
    }

    const commitSplit = ({ anchor, payload, pos }: SplitTarget) => {
      committed = true
      openSessionTile(payload.id, pos, anchor)
      // A tile for this session may already exist (openSessionTile is
      // idempotent — e.g. persisted from an earlier run): a drop must never
      // feel dead, so front/unhide/un-dismiss it either way.
      revealTreePane(`session-tile:${payload.id}`)
    }

    const onDragStart = (event: DragEvent) => {
      const target = event.target as HTMLElement | null

      if (!target?.closest?.('[data-native-drag]') || target.closest('[data-reorder-handle]')) {
        return
      }

      currentPayload = payloadFromSource(target)

      // Defuse preventDefault for this event: react-dnd's HTML5Backend cancels
      // foreign draggables outright, and a leaked dnd-kit sensor does the same.
      // Handle-origin drags are excluded above — cancelling those is the row's
      // own (intentional) guard.
      event.preventDefault = () => {}
    }

    const onDragOver = (event: DragEvent) => {
      if (!dragHasSession(event.dataTransfer)) {
        return
      }

      // Accept the whole session gesture and lock the effect: the split/link
      // decision happens at drop, and any later handler that would force
      // 'none' (see module doc) is written out of the equation.
      event.preventDefault()
      lockDropEffect(event.dataTransfer)

      // First sighting of this drag lights the zones; every sighting re-arms.
      if (!active()) {
        $treeDragging.set(SESSION_TILE_DRAG)
      }

      arm()

      const elements = elementsAt(event.clientX, event.clientY)
      const groupId = groupAt(elements)?.dataset.treeGroup

      if (!groupId) {
        lastSplitTarget = null

        if ($dropHint.get()) {
          $dropHint.set(null)
        }

        return
      }

      // The composer (and everything in it) is always the link/attach drop;
      // elsewhere the shared radial targeting decides center vs edge.
      const pos = elements.some(el => el.closest('[data-slot="composer-root"]'))
        ? 'center'
        : subZonePosition((zones ??= snapshotZones()), groupId, event.clientX, event.clientY)

      lastSplitTarget =
        pos === 'center' || !currentPayload
          ? null
          : {
              anchor: surfaceAt(elements)?.dataset.sessionAnchor ?? 'workspace',
              payload: currentPayload,
              pos: pos as SplitDir
            }

      // Publish the hovered zone even at center — the overlay fades its sheet
      // there (the link overlay owns the visual) but stays primed for edges.
      const current = $dropHint.get()

      if (current?.groupId !== groupId || current?.pos !== pos) {
        $dropHint.set({ groupId, groupIds: [groupId], kind: 'group', pos })
      }
    }

    const onDrop = (event: DragEvent) => {
      if (!dragHasSession(event.dataTransfer)) {
        return
      }

      const elements = elementsAt(event.clientX, event.clientY)
      const groupId = groupAt(elements)?.dataset.treeGroup

      const pos =
        $dropHint.get()?.pos ??
        (groupId ? subZonePosition((zones ??= snapshotZones()), groupId, event.clientX, event.clientY) : 'center')

      const payload = readSessionDrag(event.dataTransfer) ?? currentPayload

      // Only edge drops are ours; a center drop falls through to the
      // surface's own onDropSession (the link).
      if (!payload || pos === 'center') {
        clear()

        return
      }

      // preventDefault (NOT stopPropagation) marks the drop as claimed: the
      // surface's drop-zone handler sees `defaultPrevented`, resets its own
      // hover state, and skips the link insert. Swallowing the event here
      // stranded that state — the stuck "drop to link" sheet after a split.
      event.preventDefault()
      commitSplit({ anchor: surfaceAt(elements)?.dataset.sessionAnchor ?? 'workspace', payload, pos: pos as SplitDir })
      clear()
    }

    const onDragEnd = () => {
      // Belt-and-suspenders: if the browser ended the drag without a `drop`
      // (a hostile handler slipped past the armor), commit the last visible
      // edge target — what the user aimed at is what they get.
      if (!committed && lastSplitTarget) {
        commitSplit(lastSplitTarget)
      }

      clear()
    }

    window.addEventListener('dragstart', onDragStart, true)
    window.addEventListener('dragover', onDragOver, true)
    window.addEventListener('drop', onDrop, true)
    window.addEventListener('dragend', onDragEnd, true)

    return () => {
      window.removeEventListener('dragstart', onDragStart, true)
      window.removeEventListener('dragover', onDragOver, true)
      window.removeEventListener('drop', onDrop, true)
      window.removeEventListener('dragend', onDragEnd, true)
      clear()
    }
  }, [])

  return null
}
