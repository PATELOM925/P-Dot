"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { readIdentity } from "@/lib/auth-identity";
import { emailSchema, newPasswordSchema } from "@/lib/schemas";
import { ConfigError } from "@/lib/supabase-config";
import { safeNextPath } from "@/lib/safe-url";
import { getSiteUrl } from "@/server/config";
import { createSupabaseServerClient } from "@/server/db/supabase";
import { logEvent } from "@/server/log";
import { isOutage, isRateLimit, UNAVAILABLE_MESSAGE } from "./errors";
import type { AuthFormState } from "./types";

// Auth messages never reveal whether an account exists for an email address.

const UNAVAILABLE: AuthFormState = { error: UNAVAILABLE_MESSAGE };
const RATE_LIMITED: AuthFormState = { error: "Too many attempts. Please wait a few minutes and try again." };

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function firstError(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Check the form and try again.";
}

async function supabaseOrNull() {
  try {
    return await createSupabaseServerClient();
  } catch (error) {
    if (error instanceof ConfigError) {
      logEvent("error", "config_missing", { route: "auth", missing: error.missing.join(",") });
      return null;
    }
    throw error;
  }
}

export async function signInAction(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const parsed = z
    .object({ email: emailSchema, password: z.string().min(1, "Enter your password.") })
    .safeParse({ email: field(formData, "email").trim(), password: field(formData, "password") });
  const email = field(formData, "email").trim();
  if (!parsed.success) return { error: firstError(parsed.error), email };

  const supabase = await supabaseOrNull();
  if (!supabase) return { ...UNAVAILABLE, email };

  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    if (isRateLimit(error)) return { ...RATE_LIMITED, email };
    if (isOutage(error)) return { ...UNAVAILABLE, email };
    return { error: "Incorrect email or password, or the email address has not been confirmed yet.", email };
  }
  redirect(safeNextPath(field(formData, "next")));
}

export async function signUpAction(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const parsed = z
    .object({ email: emailSchema, password: newPasswordSchema, confirm: z.string() })
    .refine((value) => value.password === value.confirm, { message: "Passwords do not match." })
    .safeParse({
      email: field(formData, "email").trim(),
      password: field(formData, "password"),
      confirm: field(formData, "confirm"),
    });
  const email = field(formData, "email").trim();
  if (!parsed.success) return { error: firstError(parsed.error), email };

  const supabase = await supabaseOrNull();
  if (!supabase) return { ...UNAVAILABLE, email };

  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: { emailRedirectTo: `${getSiteUrl()}/auth/confirm?next=/chat` },
  });

  const checkEmail: AuthFormState = {
    notice: "Check your email for a confirmation link to finish creating your account.",
  };
  if (error) {
    if (isRateLimit(error)) return { ...RATE_LIMITED, email };
    if (isOutage(error)) return { ...UNAVAILABLE, email };
    if (error.code === "weak_password") return { error: "Choose a stronger password.", email };
    // Same response whether or not the address is already registered.
    if (error.code === "user_already_exists" || error.code === "email_exists") return checkEmail;
    return { error: "We could not create your account. Please try again.", email };
  }
  // With email confirmation disabled in Supabase, sign-up returns a session.
  if (data.session) redirect("/chat");
  return checkEmail;
}

export async function requestPasswordResetAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = field(formData, "email").trim();
  const parsed = emailSchema.safeParse(email);
  if (!parsed.success) return { error: firstError(parsed.error), email };

  const supabase = await supabaseOrNull();
  if (!supabase) return { ...UNAVAILABLE, email };

  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data, {
    redirectTo: `${getSiteUrl()}/auth/confirm?next=/reset-password`,
  });
  if (error && isRateLimit(error)) return { ...RATE_LIMITED, email };
  if (error && isOutage(error)) return { ...UNAVAILABLE, email };
  return { notice: "If an account exists for that email, we sent a link to reset the password." };
}

export async function updatePasswordAction(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const parsed = z
    .object({ password: newPasswordSchema, confirm: z.string() })
    .refine((value) => value.password === value.confirm, { message: "Passwords do not match." })
    .safeParse({ password: field(formData, "password"), confirm: field(formData, "confirm") });
  if (!parsed.success) return { error: firstError(parsed.error) };

  const supabase = await supabaseOrNull();
  if (!supabase) return UNAVAILABLE;

  const { data: claims } = await supabase.auth.getClaims();
  const identity = readIdentity(claims?.claims);
  if (!identity) {
    return { error: "Your reset link has expired. Request a new one from the forgot-password page." };
  }
  if (identity.isAnonymous) return { error: "A trial has no password. Create an account first." };

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    if (isOutage(error)) return UNAVAILABLE;
    if (error.code === "same_password") return { error: "Choose a password you have not used before." };
    if (error.code === "weak_password") return { error: "Choose a stronger password." };
    if (error.code === "reauthentication_needed") {
      return { error: "For security, request a new reset link and try again." };
    }
    return { error: "We could not update your password. Please try again." };
  }
  redirect("/chat");
}

/**
 * "Continue with Google" (decision 0014). Supabase stores the PKCE verifier in
 * a cookie and gives the Google URL; /auth/callback finishes the sign-in. Any
 * failure gives one message that does not say whether an account exists.
 */
export async function signInWithGoogleAction(formData: FormData): Promise<void> {
  const next = safeNextPath(field(formData, "next"));
  const supabase = await supabaseOrNull();
  let url: string | null = null;
  if (supabase) {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${getSiteUrl()}/auth/callback?next=${encodeURIComponent(next)}`, skipBrowserRedirect: true },
    });
    if (!error && data.url && new URL(data.url).protocol === "https:") url = data.url;
    else logEvent("warn", "google_sign_in_start_failed", { route: "auth.google" });
  }
  redirect(url ?? "/login?error=oauth");
}

export async function signOutAction(): Promise<void> {
  const supabase = await supabaseOrNull();
  // "local" ends this browser's session only; other devices stay signed in.
  if (supabase) await supabase.auth.signOut({ scope: "local" });
  redirect("/");
}
