import { describe, expect, it } from "vitest";
import { alwaysAskReason, mayRunOnItsOwn } from "@/lib/approval-policy";
import { actionPayloadSchema } from "@/lib/schemas";
import { failureText, isExternalKind, payloadDetails, pastProposalView } from "@/features/actions/format";
import type { ActionPayload, ActionProposalDTO } from "@/types/api";

const EMAIL: Extract<ActionPayload, { kind: "send_email" }> = { kind: "send_email", mode: "personal", to: ["sam@example.com"], subject: "Lunch", body: "Noon?" };
const EVENT: Extract<ActionPayload, { kind: "create_calendar_event" }> = {
  kind: "create_calendar_event",
  mode: "work",
  title: "Planning",
  start: "2026-11-02T10:00:00Z",
  end: "2026-11-02T11:00:00Z",
  attendees: ["sam@example.com"],
};

describe("external action payloads (the same limits as the database)", () => {
  it("accepts valid payloads and trims the text", () => {
    expect(actionPayloadSchema.parse({ ...EMAIL, subject: "  Lunch  ", to: [" sam@example.com "] })).toEqual(EMAIL);
    expect(actionPayloadSchema.parse({ ...EVENT, attendees: [] })).toEqual({ ...EVENT, attendees: [] });
    expect(actionPayloadSchema.safeParse({ ...EMAIL, to: Array(10).fill("a@example.com"), body: "b".repeat(4000) }).success).toBe(true);
  });

  it.each([
    ["a header line break in a recipient", { ...EMAIL, to: ["sam@example.com\r\nBcc: eve@example.com"] }],
    ["a recipient without a domain dot", { ...EMAIL, to: ["sam@localhost"] }],
    ["no recipient", { ...EMAIL, to: [] }],
    ["11 recipients", { ...EMAIL, to: Array(11).fill("a@example.com") }],
    ["a line break in the subject", { ...EMAIL, subject: "Lunch\nBcc: eve@example.com" }],
    ["a subject of 201 characters", { ...EMAIL, subject: "s".repeat(201) }],
    ["a body of 4,001 characters", { ...EMAIL, body: "b".repeat(4001) }],
    ["an extra key", { ...EMAIL, cc: ["x@example.com"] }],
    ["an end before the start", { ...EVENT, end: "2026-11-02T09:00:00Z" }],
    ["an event over 31 days", { ...EVENT, end: "2026-12-04T10:00:00Z" }],
    ["a time with no offset", { ...EVENT, start: "2026-11-02T10:00:00" }],
    ["21 attendees", { ...EVENT, attendees: Array(21).fill("a@example.com") }],
  ])("refuses %s", (_name, payload) => {
    expect(actionPayloadSchema.safeParse(payload).success).toBe(false);
  });
});

describe("external actions always ask", () => {
  it("never run on their own, in any mode, and say why", () => {
    for (const kind of ["send_email", "create_calendar_event"] as const) {
      expect(isExternalKind(kind)).toBe(true);
      expect(mayRunOnItsOwn(kind, "auto")).toBe(false);
      expect(mayRunOnItsOwn(kind, "manual")).toBe(false);
      expect(alwaysAskReason(kind)).toMatch(/acts outside P-Dot/);
    }
  });
});

describe("the approval card details", () => {
  it("shows every recipient, the subject and the whole body", () => {
    const body = "Line one\nLine two ".repeat(200).trim();
    const details = Object.fromEntries(payloadDetails({ ...EMAIL, to: ["a@example.com", "b@example.com"], body }, (iso) => iso));
    expect(details).toMatchObject({ To: "a@example.com, b@example.com", Subject: "Lunch", Message: body });
  });

  it("shows the times, every guest and that Google sends invitations", () => {
    const details = Object.fromEntries(payloadDetails(EVENT, (iso) => `local(${iso})`));
    expect(details).toMatchObject({
      Event: "Planning",
      Starts: "local(2026-11-02T10:00:00Z)",
      Ends: "local(2026-11-02T11:00:00Z)",
      Guests: "sam@example.com",
      Invitations: "Google emails an invitation to each guest.",
    });
    expect(Object.fromEntries(payloadDetails({ ...EVENT, attendees: [] }, (iso) => iso))).toMatchObject({ Guests: "None" });
  });

  it("names the failure reason and the in-progress state", () => {
    expect(failureText({ result: { error: "execution_failed", reason: "google_rejected" } })).toBe("Google refused this action. Nothing was sent.");
    expect(failureText({ result: { error: "execution_failed", reason: "unknown_value" } })).toMatch(/could not be completed/);
    const executing = { status: "executing", verified: true, payload: EMAIL } as unknown as ActionProposalDTO;
    expect(pastProposalView(executing)?.label).toBe("In progress");
  });
});
