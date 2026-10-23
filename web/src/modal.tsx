// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The one dialog every window in the panel uses — built on the browser's own `<dialog>`.
 *
 * THE THREE THINGS A DIALOG MUST DO, and which of them the four hand-rolled windows this replaced
 * managed: trap focus (none), close on Escape (three of four — the donation window ignored it), and
 * put focus back where it came from (none; closing one dropped the keyboard user at the top of the
 * page). That is the spec's own observation about hand-rolled dialogs, reproduced exactly.
 *
 * `showModal()` gives the first two from the platform rather than from code of ours: everything
 * outside the dialog becomes inert (Tab cannot leave it), Escape fires `cancel`, and the dialog sits
 * in the TOP LAYER — above the sticky top bar and the dock with no z-index at all, and no longer
 * needing the portals that used to escape an ancestor's backdrop-filter. Focus return is ours: the
 * element that had focus when the dialog opened is remembered and re-focused on close, unless the
 * caller names a better target (the account menu item that opened "What's new" is gone by then).
 *
 * No dependency: CLAUDE.md §13 keeps the web runtime to React + lucide, and this is the primitive
 * the spec asks for without adding one.
 *
 * A browser without `showModal()` (Safari before 15.4) gets the same window opened as a plain
 * `<dialog open>`, with Escape and first focus done here, and no focus trap. Calling showModal()
 * unguarded there threw inside an effect — and the What's-new window sits outside every section's
 * error boundary, so it blanked the whole panel.
 */
import { useEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react';

/** What showModal() would focus first, for the browsers that do not have it. */
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  titleId,
  label,
  onClose,
  returnFocus,
  initialFocus,
  className = '',
  style,
  children,
}: {
  /** id of the heading inside that names the dialog. */
  titleId?: string;
  /** Used only when there is no visible heading to point at. */
  label?: string;
  onClose: () => void;
  /** Where focus goes on close, when the opener will not exist any more. */
  returnFocus?: RefObject<HTMLElement | null>;
  /** What to focus on open. Default: the dialog's first focusable element. */
  initialFocus?: RefObject<HTMLElement | null>;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Held in a ref so a parent that passes a fresh arrow function each render does not re-run the
  // open/close effect — which would close and re-open the dialog on every keystroke inside it.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const native = typeof dialog.showModal === 'function';
    if (native) {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
      dialog.classList.add('modal--fallback');
    }
    const first = initialFocus?.current ?? (native ? null : dialog.querySelector<HTMLElement>(FOCUSABLE));
    first?.focus();

    // Escape. Prevented so the browser does not close the dialog behind React's back — the parent
    // unmounts it, which is the only close there is.
    const onCancel = (e: Event) => {
      e.preventDefault();
      closeRef.current();
    };
    // A click on the dim backdrop. The backdrop has no element of its own, so the event arrives on the
    // dialog itself; a click inside the dialog's box (its padding included) is not a backdrop click.
    // BOTH ends of the click must be outside: selecting text in the window and releasing over the
    // backdrop also lands a click on the dialog, and closing on that loses whatever was being read.
    const outside = (e: MouseEvent) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    let downOutside = false;
    const onDown = (e: PointerEvent) => {
      downOutside = e.target === dialog && outside(e);
    };
    const onClick = (e: MouseEvent) => {
      if (downOutside && e.target === dialog && outside(e)) closeRef.current();
      downOutside = false;
    };
    // Without showModal() there is no `cancel` event, so Escape is heard here instead.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current();
      }
    };
    dialog.addEventListener('cancel', onCancel);
    dialog.addEventListener('pointerdown', onDown);
    dialog.addEventListener('click', onClick);
    if (!native) document.addEventListener('keydown', onKey);
    return () => {
      dialog.removeEventListener('cancel', onCancel);
      dialog.removeEventListener('pointerdown', onDown);
      dialog.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
      if (!native) dialog.removeAttribute('open');
      else if (dialog.open) dialog.close();
      const target = returnFocus?.current ?? opener;
      // The opener can have unmounted in the meantime (a row that re-rendered, a menu that closed);
      // focusing a detached node does nothing, and then focus stays on <body>, which is the bug.
      if (target && target.isConnected) target.focus();
    };
    // Empty on purpose: the dialog opens once, for its whole life, and the refs are read at close time.
  }, []);

  return (
    <dialog
      ref={ref}
      className={`modal glass-raised${className ? ` ${className}` : ''}`}
      style={style}
      aria-labelledby={titleId}
      aria-label={titleId ? undefined : label}
    >
      {children}
    </dialog>
  );
}
