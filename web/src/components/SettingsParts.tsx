import type React from "react";

export function H({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-5 text-[18px] font-medium">{children}</h2>;
}

export function Group({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="settings-group mb-6">
      {title && <div className="mb-2 text-[12.5px] text-muted">{title}</div>}
      <div className="overflow-hidden rounded-2xl border border-line bg-card/50">{children}</div>
    </div>
  );
}

export function Row({ title, desc, children }: { title: string; desc?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="settings-row flex items-center gap-4 border-b border-line px-4 py-3.5 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px]">{title}</div>
        {desc && <div className="mt-0.5 text-[12.5px] text-muted">{desc}</div>}
      </div>
      {children}
    </div>
  );
}
