import { BrandLink } from "@/components/layout/BrandLink";
import { SiteFooter } from "./SiteFooter";

export function LegalPage({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  return (
    <div className="landing">
      <header className="landing-header">
        <BrandLink />
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
