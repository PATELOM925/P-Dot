import type { Metadata } from "next";
import Link from "next/link";
import { signUpAction } from "@/features/auth/actions";
import { AuthForm } from "@/features/auth/AuthForm";
import { ConfigError } from "@/lib/supabase-config";
import { getAuthContext } from "@/server/auth/session";
import { GoogleSignInButton } from "@/features/auth/GoogleSignInButton";

export const metadata: Metadata = { title: "Create account · P-Dot" };

async function isTrial(): Promise<boolean> {
  try {
    return (await getAuthContext())?.isAnonymous === true;
  } catch (error) {
    if (error instanceof ConfigError) return false;
    throw error;
  }
}

export default async function SignupPage() {
  const trial = await isTrial();
  return (
    <>
      <h1>Create your account</h1>
      {trial && (
        <p className="alert alert-notice">
          Your trial chats do not move to the new account. The new account starts empty.
        </p>
      )}
      <GoogleSignInButton />
      <p className="muted">Or create an account with your email and a password.</p>
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
