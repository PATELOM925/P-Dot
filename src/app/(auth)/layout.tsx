import Link from "next/link";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="auth-shell">
      <Link href="/" className="brand">
        P-Dot
      </Link>
      <section className="card">{children}</section>
    </main>
  );
}
