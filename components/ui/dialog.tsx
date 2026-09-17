"use client";
import { useEffect, useRef, type ReactNode } from "react";

/** Native modal supplies focus containment, background inertness and focus return. */
export function Dialog({ open, onClose, label, className = "", children }: {
  open: boolean; onClose: () => void; label: string; className?: string; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return <dialog ref={ref} className={className} aria-label={label}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClose={() => { if (open) onClose(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const r = event.currentTarget.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) onClose();
    }}>{children}</dialog>;
}
