"use client";

import { useFormStatus } from "react-dom";
import { signInWithGoogleAction } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="button" disabled={pending} aria-disabled={pending}>
      {pending ? "Opening Google…" : "Continue with Google"}
    </button>
  );
}

/** Sign-in with Google through Supabase. Asks Google only for the address and the basic profile. */
export function GoogleSignInButton({ next }: { next?: string }) {
  return (
    <form action={signInWithGoogleAction} className="stack">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <SubmitButton />
    </form>
  );
}
