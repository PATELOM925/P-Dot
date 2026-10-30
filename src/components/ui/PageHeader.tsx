import type { ReactNode } from "react";
import { InfoNote } from "./InfoNote";

export { InfoNote };

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
