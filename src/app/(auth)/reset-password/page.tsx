import type { Metadata } from "next";
import { updatePasswordAction } from "@/features/auth/actions";
import { AuthForm } from "@/features/auth/AuthForm";
import { requireAuth } from "@/server/auth/session";

export const metadata: Metadata = { title: "Choose a new password · P-Dot" };

// Reached from a password-recovery email (which signs the user in) or from Settings.
export default async function ResetPasswordPage() {
  await requireAuth("/reset-password");

  return (
    <>
      <h1>Choose a new password</h1>
      <AuthForm
        action={updatePasswordAction}
        submitLabel="Update password"
        pendingLabel="Updating…"
        fields={[
          {
            name: "password",
            label: "New password",
            type: "password",
            autoComplete: "new-password",
            hint: "At least 8 characters.",
          },
          { name: "confirm", label: "Confirm new password", type: "password", autoComplete: "new-password" },
        ]}
      />
    </>
  );
}
