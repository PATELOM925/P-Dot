import Link from "next/link";

export function TrialBanner() {
  return (
    <p className="trial-banner">
      <span className="trial-banner-long">
        Trial without an account. When you end the trial, you cannot open these chats again.
      </span>
      <span className="trial-banner-short">Trial. Chats end when the trial ends.</span>{" "}
      <Link href="/signup">Create an account</Link>
    </p>
  );
}
