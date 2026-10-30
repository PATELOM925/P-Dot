import Link from "next/link";

export function TrialBanner() {
  return (
    <p className="trial-banner">
      You are trying P-Dot without an account. When you sign out, you lose these chats.{" "}
      <Link href="/signup">Create an account</Link> to keep your chats.
    </p>
  );
}
