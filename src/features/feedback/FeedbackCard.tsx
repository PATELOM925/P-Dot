"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ApiError, sendJson } from "@/lib/api-client";
import { FEEDBACK_KINDS, type FeedbackKind } from "@/lib/feedback";
import { MAX_FEEDBACK_TEXT_CHARS } from "@/lib/limits";

type Phase = { kind: "editing"; error: string | null } | { kind: "sending" } | { kind: "sent" };

/** "What should P-Dot connect to next?" Pick a suggestion or Other, add an optional note, send. */
export function FeedbackCard({ className = "panel" }: { className?: string }) {
  const id = useId();
  const [kind, setKind] = useState<FeedbackKind | null>(null);
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "editing", error: null });
  const thanksRef = useRef<HTMLParagraphElement>(null);
  const isOther = kind === "other";
  const ready = kind !== null && (!isOther || text.trim() !== "") && phase.kind !== "sending";

  // The form goes away after a send, so focus moves to the thanks line, which a screen reader then reads.
  useEffect(() => {
    if (phase.kind === "sent") thanksRef.current?.focus();
  }, [phase.kind]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setPhase({ kind: "sending" });
    try {
      await sendJson("/api/feedback", "POST", { kind, text: text.trim() || null });
      setPhase({ kind: "sent" });
    } catch (error) {
      setPhase({ kind: "editing", error: error instanceof ApiError ? error.message : "Could not send. Try again." });
    }
  }

  return (
    <section className={`${className} feedback-card`} id="feedback" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>What should P-Dot connect to next?</h2>
      {phase.kind === "sent" ? (
        <p ref={thanksRef} tabIndex={-1}>
          Thanks, we read every request.
        </p>
      ) : (
        <form className="stack" onSubmit={(event) => void submit(event)}>
          <fieldset className="feedback-kinds">
            <legend className="visually-hidden">Choose one</legend>
            {FEEDBACK_KINDS.map((option) => (
              <label key={option.id} className={`choice-chip${kind === option.id ? " is-selected" : ""}`}>
                <input
                  type="radio"
                  name={`${id}-kind`}
                  value={option.id}
                  checked={kind === option.id}
                  onChange={() => setKind(option.id)}
                />
                {option.label}
              </label>
            ))}
          </fieldset>
          <div className="field">
            <label htmlFor={`${id}-text`}>{isOther ? "What should P-Dot connect to?" : "Note (optional)"}</label>
            <textarea
              id={`${id}-text`}
              className="form-control"
              rows={2}
              value={text}
              maxLength={MAX_FEEDBACK_TEXT_CHARS}
              required={isOther}
              aria-describedby={`${id}-count`}
              onChange={(event) => setText(event.target.value)}
            />
            <span id={`${id}-count`} className="hint">
              {text.length} of {MAX_FEEDBACK_TEXT_CHARS} characters
            </span>
          </div>
          <div className="actions">
            <button type="submit" className="button button-primary button-small" disabled={!ready}>
              {phase.kind === "sending" ? "Sending…" : "Send"}
            </button>
          </div>
          {phase.kind === "editing" && phase.error && (
            <p className="alert alert-error small" role="alert">
              {phase.error}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
