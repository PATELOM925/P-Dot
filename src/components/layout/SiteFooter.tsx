import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <nav aria-label="Legal" className="site-footer-links">
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
      </nav>
      <p className="muted small">P-Dot is a hackathon project. It is not a finished product.</p>
    </footer>
  );
}
