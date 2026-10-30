import { BrandLink } from "@/components/layout/BrandLink";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="auth-shell">
      <BrandLink />
      <section className="card">{children}</section>
    </main>
  );
}
