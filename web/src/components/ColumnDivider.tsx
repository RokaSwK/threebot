import { useEffect, useRef } from "react";
import { COLUMN_LIMITS, type Column } from "../lib/layout";
import { setColumnWidth, useApp } from "../store";

export function ColumnDivider({ column }: { column: Column }) {
  const width = useApp((s) => column === "sidebar" ? s.sidebarWidth : s.detailsWidth);
  const start = useRef<{ x: number; width: number } | null>(null);
  const limits = COLUMN_LIMITS[column];
  useEffect(() => () => document.documentElement.classList.remove("resizing-columns"), []);
  const finish = () => {
    if (!start.current) return;
    start.current = null;
    const s = useApp.getState();
    setColumnWidth({ column, width: column === "sidebar" ? s.sidebarWidth : s.detailsWidth });
    document.documentElement.classList.remove("resizing-columns");
  };
  return <div className="column-divider relative z-20 w-0 shrink-0 outline-none" role="separator" tabIndex={0} aria-label={`Resize ${column}`} aria-orientation="vertical" aria-valuemin={limits.min} aria-valuemax={limits.max} aria-valuenow={width}
    onPointerDown={(event) => { if (!event.isPrimary || event.button !== 0) return; event.preventDefault(); start.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); document.documentElement.classList.add("resizing-columns"); }}
    onPointerMove={(event) => { if (!start.current) return; setColumnWidth({ column, width: start.current.width + (event.clientX - start.current.x) * (column === "sidebar" ? 1 : -1), persist: false }); }}
    onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
    onDoubleClick={() => setColumnWidth({ column, width: limits.initial })}
    onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setColumnWidth({ column, width: width + (event.key === "ArrowRight" ? 8 : -8) * (column === "sidebar" ? 1 : -1) }); } }}>
    <span className="absolute inset-y-0 -left-1 w-2 cursor-col-resize touch-none hover:bg-accent/20 focus-visible:bg-accent/20" />
  </div>;
}
