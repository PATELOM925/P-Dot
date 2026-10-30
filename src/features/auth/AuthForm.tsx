"use client";

import { useActionState } from "react";
import { usePageShowKey } from "@/lib/page-show";
import { initialAuthFormState, type AuthFormState } from "./types";

export interface AuthField {
  name: string;
  label: string;
  type: "email" | "password";
  autoComplete: string;
  hint?: string;
}

interface AuthFormProps {
  action: (state: AuthFormState, formData: FormData) => Promise<AuthFormState>;
  fields: AuthField[];
  submitLabel: string;
  pendingLabel: string;
  hidden?: Record<string, string>;
}

/** Remounts the form when Back shows the page from the back/forward cache, so the button is not stuck pending. */
export function AuthForm(props: AuthFormProps) {
  return <AuthFormBody key={usePageShowKey()} {...props} />;
}

function AuthFormBody({ action, fields, submitLabel, pendingLabel, hidden }: AuthFormProps) {
  const [state, formAction, pending] = useActionState(action, initialAuthFormState);
  const errorId = "auth-form-error";

  return (
    <form action={formAction} className="stack" aria-describedby={state.error ? errorId : undefined}>
      {hidden &&
        Object.entries(hidden).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}

      {fields.map((field) => (
        <div className="field" key={field.name}>
          <label htmlFor={field.name}>{field.label}</label>
          <input
            id={field.name}
            name={field.name}
            type={field.type}
            autoComplete={field.autoComplete}
            required
            maxLength={field.type === "email" ? 254 : 128}
            defaultValue={field.type === "email" ? state.email : undefined}
            aria-invalid={state.error ? true : undefined}
            aria-describedby={field.hint ? `${field.name}-hint` : undefined}
          />
          {field.hint && (
            <p className="hint" id={`${field.name}-hint`}>
              {field.hint}
            </p>
          )}
        </div>
      ))}

      {state.error && (
        <p className="alert alert-error" id={errorId} role="alert">
          {state.error}
        </p>
      )}
      {state.notice && (
        <p className="alert alert-notice" role="status">
          {state.notice}
        </p>
      )}

      <button type="submit" className="button button-primary" disabled={pending}>
        {pending ? pendingLabel : submitLabel}
      </button>
    </form>
  );
}
