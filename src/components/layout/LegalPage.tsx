import Link from "next/link";
import { SiteFooter } from "./SiteFooter";

export function LegalPage({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  return (
    <div className="landing">
      <header className="landing-header">
        <Link href="/" className="brand">
          P-Dot
        </Link>
      </header>
      <main className="legal-page">
        <h1>{title}</h1>
        <p className="muted small">Last changed {updated}.</p>
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
