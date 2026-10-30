import type { ReactNode } from "react";

/** A page title, with optional actions and an optional "How this works" note that stays closed until opened. */
export function PageHeader({ title, info, children }: { title: string; info?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <h1>{title}</h1>
      {info && <InfoNote label="About this page">{info}</InfoNote>}
      {children && <div className="page-head-actions">{children}</div>}
    </div>
  );
}

/** A small (i) button that opens a short note. A native <details>, so it works with the keyboard and without script. */
export function InfoNote({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="info-note">
      <summary aria-label={label} title={label}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v6M12 7.5v.01" />
        </svg>
      </summary>
      <div className="info-note-body">{children}</div>
    </details>
  );
}
