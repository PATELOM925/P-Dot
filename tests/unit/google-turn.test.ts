import { describe, expect, it } from "vitest";
import { CALENDAR_OFF_REPLY, GMAIL_OFF_REPLY, SEND_OFF_REPLY, googleForTurn } from "@/server/assistant/google-turn";
import type { GoogleServices } from "@/server/assistant/tools/google";
import type { GoogleConnection } from "@/server/db/connected-accounts";
import { CALENDAR_SCOPE, GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE } from "@/server/google/oauth";

function deps(scopes: GoogleConnection["scopes"]) {
  const connection: GoogleConnection = { email: "owner@example.com", scopes, status: "connected" };
  return { google: { accounts: { getGoogleConnection: async () => connection } } as unknown as GoogleServices };
}

describe("googleForTurn with a missing scope (live test, 2026-10-30)", () => {
  it("does not search Gmail for a calendar question when only Gmail read is allowed", async () => {
    const turn = await googleForTurn(deps([GMAIL_READ_SCOPE]), "u1", true, "What meetings do I have today?");
    expect(turn?.flags).toBeNull();
    expect(turn?.note).toContain(CALENDAR_OFF_REPLY);
    expect(turn?.note).toContain("Do not search Gmail instead");
  });

  it("keeps Gmail read when the calendar question also names email", async () => {
    const turn = await googleForTurn(deps([GMAIL_READ_SCOPE]), "u1", true, "Any email about my meeting today?");
    expect(turn?.flags).toEqual({ read: true, send: false, calendar: false });
    expect(turn?.note).toContain(CALENDAR_OFF_REPLY);
    expect(turn?.note).toContain("Use gmail_search, gmail_read");
  });

  it("keeps send when only the calendar is missing", async () => {
    const turn = await googleForTurn(deps([GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE]), "u1", true, "Am I free tomorrow?");
    expect(turn?.flags).toEqual({ read: false, send: true, calendar: false });
    expect(turn?.note).toContain(CALENDAR_OFF_REPLY);
  });

  it("tells the user that send is off for a send request without the send scope", async () => {
    const turn = await googleForTurn(deps([GMAIL_READ_SCOPE, CALENDAR_SCOPE]), "u1", true, "Send an email to Sam about lunch");
    expect(turn?.flags).toEqual({ read: true, send: false, calendar: true });
    expect(turn?.note).toContain(SEND_OFF_REPLY);
  });

  it("adds no missing-scope line when every needed scope is there", async () => {
    const turn = await googleForTurn(deps([GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE, CALENDAR_SCOPE]), "u1", true, "What meetings do I have today?");
    expect(turn?.note).not.toContain("access is off");
    expect(turn?.flags).toEqual({ read: true, send: true, calendar: true });
  });

  it("adds no missing-scope line for a mail question without the calendar scope", async () => {
    const turn = await googleForTurn(deps([GMAIL_READ_SCOPE]), "u1", true, "Any unread email from Sam?");
    expect(turn?.flags).toEqual({ read: true, send: false, calendar: false });
    expect(turn?.note).not.toContain("access is off");
  });

  it("tells the user that Gmail is off for a mail question with only the calendar scope", async () => {
    const turn = await googleForTurn(deps([CALENDAR_SCOPE]), "u1", true, "Any unread email from Sam?");
    expect(turn?.flags).toEqual({ read: false, send: false, calendar: true });
    expect(turn?.note).toContain(GMAIL_OFF_REPLY);
    expect(turn?.note).not.toContain("Do not search Gmail instead");
  });

  it("says not to search Gmail only for a calendar-only question", async () => {
    const both = await googleForTurn(deps([GMAIL_READ_SCOPE]), "u1", true, "Any email about my meeting today?");
    expect(both?.note).toContain(CALENDAR_OFF_REPLY);
    expect(both?.note).not.toContain("Do not search Gmail instead");
    const send = await googleForTurn(deps([GMAIL_READ_SCOPE, CALENDAR_SCOPE]), "u1", true, "Send an email to Sam about lunch");
    expect(send?.note).not.toContain("Do not search Gmail instead");
  });
});
