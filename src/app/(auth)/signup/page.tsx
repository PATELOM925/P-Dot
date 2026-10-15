import type { Metadata } from "next";
import Link from "next/link";
import { signUpAction } from "@/features/auth/actions";
import { AuthForm } from "@/features/auth/AuthForm";

export const metadata: Metadata = { title: "Create account · P-Dot" };

export default function SignupPage() {
  return (
    <>
      <h1>Create your account</h1>
      <AuthForm
        action={signUpAction}
        submitLabel="Create account"
        pendingLabel="Creating account…"
        fields={[
          { name: "email", label: "Email", type: "email", autoComplete: "email" },
          {
            name: "password",
            label: "Password",
            type: "password",
            autoComplete: "new-password",
            hint: "At least 8 characters.",
          },
          { name: "confirm", label: "Confirm password", type: "password", autoComplete: "new-password" },
        ]}
      />
      <p className="muted">
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
    </>
  );
}
