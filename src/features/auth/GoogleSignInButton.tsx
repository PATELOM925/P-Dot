"use client";

import { useFormStatus } from "react-dom";
import { usePageShowKey } from "@/lib/page-show";
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
  // A new key after Back from Google remounts the form, so the button is not stuck pending.
  const key = usePageShowKey();
  return (
    <form key={key} action={signInWithGoogleAction} className="stack">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <SubmitButton />
    </form>
  );
}
