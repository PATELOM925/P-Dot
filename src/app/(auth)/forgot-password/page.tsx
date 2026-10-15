import type { Metadata } from "next";
import Link from "next/link";
import { requestPasswordResetAction } from "@/features/auth/actions";
import { AuthForm } from "@/features/auth/AuthForm";

export const metadata: Metadata = { title: "Reset password · P-Dot" };

export default function ForgotPasswordPage() {
  return (
    <>
      <h1>Reset your password</h1>
      <p className="muted">Enter your account email and we will send you a link to choose a new password.</p>
      <AuthForm
        action={requestPasswordResetAction}
        submitLabel="Send reset link"
        pendingLabel="Sending…"
        fields={[{ name: "email", label: "Email", type: "email", autoComplete: "email" }]}
      />
      <p className="muted">
        <Link href="/login">Back to sign in</Link>
      </p>
    </>
  );
}
