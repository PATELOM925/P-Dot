import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeLogEntry,
  fromLocalInputValue,
  isUnconfirmedDone,
  matchesFilter,
  pastProposalView,
  payloadDetails,
  toLocalInputValue,
  visibleProposals,
  needsUser,
  leaseTimerDelayMs,
  leaseRemainingMs,
} from "@/features/actions/format";
import { builtInStatus, countPhrase } from "@/features/connectors/status";
import { describeFile, fileSizeProblem, textProblem } from "@/features/documents/file";
import { ApiError, apiRequest, sendJson } from "@/lib/api-client";
import { MAX_DOCUMENT_BODY_BYTES, MAX_DOCUMENT_CHARS, MAX_DOCUMENT_TITLE_CHARS } from "@/lib/limits";
import manifest from "@/app/manifest";
import type {
  ActionLogEntryDTO,
  ActionPayload,
  ActionProposalDTO,
  DocumentDTO,
  MemoryDTO,
  ReminderDTO,
  TaskDTO,
} from "@/types/api";

function proposal(overrides: Partial<ActionProposalDTO> & { payload?: ActionPayload } = {}): ActionProposalDTO {
  return {
    id: "p1",
    conversationId: "c1",
    payload: { kind: "create_task", mode: "personal", title: "Pay the invoice" },
    summary: "Add task: Pay the invoice",
    status: "proposed",
    result: null,
    createdAt: "2026-10-19T10:00:00+00:00",
    decidedAt: null,
    verified: false,
    ...overrides,
  };
}

describe("approval list filtering", () => {
  it("matches by conversation and by mode", () => {
    const p = proposal();
    expect(matchesFilter(p, {})).toBe(true);
    expect(matchesFilter(p, { conversationId: "c1" })).toBe(true);
    expect(matchesFilter(p, { conversationId: "c2" })).toBe(false);
    expect(matchesFilter(p, { mode: "personal" })).toBe(true);
    expect(matchesFilter(p, { mode: "work" })).toBe(false);
  });

  it("shows waiting proposals and keeps the ones decided here", () => {
    const waiting = proposal({ id: "a" });
    const decidedHere = proposal({ id: "b", status: "executed" });
    const decidedElsewhere = proposal({ id: "c", status: "rejected" });
    const { visible } = visibleProposals([waiting, decidedHere, decidedElsewhere], {}, new Set(["b"]));
    expect(visible.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("keeps an executing external action visible after a reload, with nothing decided here", () => {
    const executing = proposal({
      id: "e",
      status: "executing",
      payload: { kind: "send_email", mode: "personal", to: ["sam@example.com"], subject: "Hi", body: "B" },
    });
    expect(needsUser(executing)).toBe(true);
    expect(needsUser(proposal({ status: "executed" }))).toBe(false);
    expect(visibleProposals([executing], {}, new Set()).visible.map((p) => p.id)).toEqual(["e"]);
  });

  it("measures the lease left for recovery", () => {
    const start = "2026-10-30T09:00:00.000Z";
    const t0 = Date.parse(start);
    expect(leaseRemainingMs(start, t0 + 10_000, 120)).toBe(110_000);
    expect(leaseRemainingMs(start, t0 + 121_000, 120)).toBe(0);
    expect(leaseRemainingMs(null, t0, 120)).toBe(0);
    expect(leaseRemainingMs("not a date", t0, 120)).toBe(0);
  });

  it("schedules the lease check from the clock at scheduling time, also after a renewal", () => {
    const first = "2026-10-30T09:00:00.000Z";
    const t0 = Date.parse(first);
    expect(leaseTimerDelayMs(first, t0 + 60_000, 120)).toBe(60_500);
    // The lease is renewed at t0 + 130 s; the card schedules again with the clock of that moment.
    const renewed = new Date(t0 + 130_000).toISOString();
    expect(leaseTimerDelayMs(renewed, t0 + 131_000, 120)).toBe(119_500);
    expect(leaseTimerDelayMs(first, t0 + 200_000, 120)).toBe(0);
    expect(leaseTimerDelayMs(null, t0, 120)).toBe(0);
  });

  it("counts proposals waiting in the other mode", () => {
    const work = proposal({ id: "w", payload: { kind: "create_task", mode: "work", title: "Ship" } });
    const workDone = proposal({ id: "x", status: "executed", payload: { kind: "create_task", mode: "work", title: "Done" } });
    const { visible, waitingInOtherMode } = visibleProposals([proposal(), work, workDone], { mode: "personal" }, new Set());
    expect(visible.map((p) => p.id)).toEqual(["p1"]);
    expect(waitingInOtherMode).toBe(1);
  });
});

describe("payload details", () => {
  it("describes what will run from the payload, not the summary", () => {
    const details = payloadDetails(
      { kind: "create_reminder", mode: "work", title: "Call Sam", dueAt: "2026-10-30T17:00:00Z" },
      (iso) => `date(${iso})`,
    );
    expect(details).toEqual([
      ["Reminder", "Call Sam"],
      ["Due", "date(2026-10-30T17:00:00Z)"],
      ["List", "Work"],
    ]);
    expect(payloadDetails({ kind: "save_memory", mode: "personal", content: "I'm vegetarian" }, String)).toEqual([
      ["Memory", "I'm vegetarian"],
      ["List", "Personal"],
    ]);
  });
});

describe("datetime-local conversion", () => {
  it("round-trips a local time", () => {
    const iso = fromLocalInputValue("2026-10-30T17:05");
    expect(iso).not.toBeNull();
    expect(toLocalInputValue(iso!)).toBe("2026-10-30T17:05");
  });

  it("returns a UTC ISO string the reminder schema accepts", () => {
    expect(fromLocalInputValue("2026-10-30T17:05")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("rejects empty and malformed values", () => {
    expect(fromLocalInputValue("")).toBeNull();
    expect(fromLocalInputValue("tomorrow")).toBeNull();
    expect(fromLocalInputValue("2026-13-45T99:99")).toBeNull();
    expect(toLocalInputValue("not a date")).toBe("");
  });
});

describe("decided proposals in chat", () => {
  it("shows Done with the result link only for a result the database confirmed", () => {
    expect(pastProposalView(proposal({ status: "executed", verified: true }))).toEqual({
      label: "Done",
      pill: "status-executed",
      note: "Approved and done.",
      showResult: true,
    });
  });

  it("shows Marked done, neutral and without a result link, for a result the database did not confirm", () => {
    const view = { label: "Marked done", pill: "status-unconfirmed", note: "P-Dot did not confirm this action.", showResult: false };
    expect(pastProposalView(proposal({ status: "executed", verified: false }))).toEqual(view);
    const older: Partial<ActionProposalDTO> = proposal({ status: "executed" });
    delete older.verified;
    expect(pastProposalView(older as ActionProposalDTO)).toEqual(view);
    expect(isUnconfirmedDone(older as ActionProposalDTO)).toBe(true);
  });

  it("does not change the other states", () => {
    expect(pastProposalView(proposal({ status: "proposed" }))).toBeNull();
    expect(pastProposalView(proposal({ status: "rejected", verified: false }))?.label).toBe("Cancelled");
    expect(pastProposalView(proposal({ status: "failed", verified: true }))?.label).toBe("Failed");
    expect(isUnconfirmedDone(proposal({ status: "failed", verified: false }))).toBe(false);
  });
});

describe("action log wording", () => {
  const entry = (
    event: ActionLogEntryDTO["event"],
    detail: ActionLogEntryDTO["detail"],
    verified = true,
  ): ActionLogEntryDTO => ({
    id: "e1",
    proposalId: null,
    event,
    detail,
    createdAt: "2026-10-19T10:00:00+00:00",
    verified,
  });

  it("says an action was completed only when the database confirmed it", () => {
    const detail = { kind: "create_task", mode: "personal", taskId: "t1" };
    expect(describeLogEntry(entry("executed", detail, true))).toEqual({
      title: "Action completed",
      facts: ["Task", "Personal"],
      tone: "success",
    });
    const unconfirmed = {
      title: "Marked as completed",
      facts: ["Task", "Personal", "P-Dot did not confirm this action."],
      tone: "neutral",
    };
    expect(describeLogEntry(entry("executed", detail, false))).toEqual(unconfirmed);
    // An older row without the field is not confirmed either.
    const older: Partial<ActionLogEntryDTO> = entry("executed", detail);
    delete older.verified;
    expect(describeLogEntry(older as ActionLogEntryDTO)).toEqual(unconfirmed);
    // A verified key in the detail is not trusted.
    expect(describeLogEntry(entry("executed", { ...detail, verified: true }, false)).title).toBe("Marked as completed");
  });

  it("names the event and the safe facts, leaving out IDs", () => {
    const view = describeLogEntry(
      entry("executed", { proposalId: "p1", kind: "create_task", edited: true, taskId: "t1" }),
    );
    expect(view).toEqual({ title: "Action completed", facts: ["Task", "Edited before approval"], tone: "success" });
    expect(JSON.stringify(view)).not.toContain("t1");
  });

  it("describes memory and reminder changes", () => {
    expect(describeLogEntry(entry("memory_added", { memoryId: "m", mode: "work", source: "assistant" }))).toEqual({
      title: "Memory added",
      facts: ["Work", "Suggested by P-Dot"],
      tone: "neutral",
    });
    expect(describeLogEntry(entry("reminder_changed", { reminderId: "r", mode: "personal", status: "done" })).facts).toEqual([
      "Personal",
      "Marked done",
    ]);
    expect(describeLogEntry(entry("failed", { kind: "save_memory", error: "execution_failed" })).tone).toBe("danger");
  });

  it("shows an unknown event instead of hiding it", () => {
    const view = describeLogEntry(entry("calendar_changed" as ActionLogEntryDTO["event"], {}));
    expect(view.title).toBe("calendar changed");
  });

  it("says how many searchable parts a document has, without its ID", () => {
    const view = describeLogEntry(entry("document_ready", { documentId: "d1", mode: "work", chunkCount: 3 }));
    expect(view).toEqual({ title: "Document ready to search", facts: ["Work", "3 searchable parts"], tone: "neutral" });
    expect(describeLogEntry(entry("document_ready", { chunkCount: 1 })).facts).toEqual(["1 searchable part"]);
  });

  it("names each document step, and shows a failed one as a problem", () => {
    expect(describeLogEntry(entry("document_added", { documentId: "d1", mode: "work", status: "processing" }))).toEqual({
      title: "Document added",
      facts: ["Work", "Processing"],
      tone: "neutral",
    });
    expect(describeLogEntry(entry("document_failed", { documentId: "d1", mode: "work" }))).toEqual({
      title: "Document could not be processed",
      facts: ["Work"],
      tone: "danger",
    });
  });
});

describe("document file checks", () => {
  it("takes the title from the file name and the media type from its extension", () => {
    expect(describeFile("Trip plan.md")).toMatchObject({ title: "Trip plan", mediaType: "text/markdown", kind: "text" });
    expect(describeFile("notes.v2.TXT")).toMatchObject({ title: "notes.v2", mediaType: "text/plain" });
    expect(describeFile("README.markdown")).toMatchObject({ title: "README", mediaType: "text/markdown" });
    // A file called only ".md" keeps its whole name as the title.
    expect(describeFile(".md")).toMatchObject({ title: ".md", mediaType: "text/markdown" });
  });

  it("refuses files with no extension or an unknown one", () => {
    for (const name of ["notes", "archive.md.zip", "setup.exe", "photo.heic"]) {
      expect(describeFile(name)).toHaveProperty("error");
    }
  });

  it("keeps titles within the API limit", () => {
    const described = describeFile(`${"a".repeat(MAX_DOCUMENT_TITLE_CHARS + 50)}.txt`);
    expect("title" in described && described.title.length).toBe(MAX_DOCUMENT_TITLE_CHARS);
  });

  it("checks size and text the way the API does", () => {
    expect(fileSizeProblem(MAX_DOCUMENT_BODY_BYTES)).toBeNull();
    expect(fileSizeProblem(MAX_DOCUMENT_BODY_BYTES + 1)).toMatch(/too large/);
    expect(textProblem("Some notes")).toBeNull();
    expect(textProblem(" \n\t ")).toBe("This file is empty.");
    expect(textProblem("x".repeat(MAX_DOCUMENT_CHARS))).toBeNull();
    expect(textProblem("x".repeat(MAX_DOCUMENT_CHARS + 1))).toMatch(/Documents can have up to/);
  });
});

describe("connectors status", () => {
  const task = (done: boolean): TaskDTO => ({ id: "t", mode: "personal", title: "T", done, createdAt: "2026-10-19" });
  const reminder = (status: ReminderDTO["status"]): ReminderDTO => ({
    id: "r",
    mode: "personal",
    title: "R",
    dueAt: "2026-10-30T17:00:00Z",
    status,
    proposalId: null,
    createdAt: "2026-10-19",
    updatedAt: "2026-10-19",
  });
  const memory = (status: MemoryDTO["status"]): MemoryDTO => ({
    id: "m",
    mode: "personal",
    content: "M",
    status,
    source: "user",
    sourceMessageId: null,
    createdAt: "2026-10-19",
    updatedAt: "2026-10-19",
  });
  const document = (status: DocumentDTO["status"]): DocumentDTO => ({
    id: "d",
    mode: "personal",
    title: "D",
    mediaType: "text/plain",
    charCount: 10,
    status,
    createdAt: "2026-10-19",
  });
  const limits = { tasks: 200, reminders: 200, memories: 200, documents: 100 };
  const now = Date.parse("2026-10-19T12:00:00Z");

  it("counts what is open, upcoming, remembered and ready", () => {
    const status = builtInStatus(
      {
        tasks: [task(false), task(true), task(false)],
        reminders: [reminder("scheduled"), reminder("done")],
        memories: [memory("active"), memory("proposed")],
        documents: [document("ready"), document("failed"), document("processing")],
      },
      limits,
      now,
    );
    expect(status).toEqual({
      tasks: "2 open tasks",
      reminders: "1 upcoming reminder",
      memory: "1 memory, 1 waiting for you",
      documents: "1 document ready",
    });
  });

  it("does not call an overdue reminder upcoming", () => {
    const overdue = { ...reminder("scheduled"), dueAt: "2026-10-18T09:00:00Z" };
    const lists = { tasks: [], memories: [], documents: [] };
    expect(builtInStatus({ ...lists, reminders: [overdue, reminder("scheduled")] }, limits, now).reminders).toBe(
      "1 upcoming reminder, 1 overdue",
    );
    expect(builtInStatus({ ...lists, reminders: [overdue] }, limits, now).reminders).toBe(
      "No upcoming reminders, 1 overdue",
    );
  });

  it("says when nothing is there", () => {
    expect(builtInStatus({ tasks: [], reminders: [], memories: [], documents: [] }, limits, now)).toEqual({
      tasks: "No open tasks",
      reminders: "No upcoming reminders",
      memory: "No memories",
      documents: "No documents ready",
    });
  });

  it("does not claim an exact count when a list stopped at its limit", () => {
    const noun = { one: "open task", many: "open tasks" };
    expect(countPhrase(200, noun, true)).toBe("200+ open tasks");
    expect(countPhrase(1, noun, true)).toBe("1+ open tasks");
    expect(countPhrase(0, noun, true)).toBe("No recent open tasks");
    const tasks = Array.from({ length: 3 }, () => task(false));
    expect(
      builtInStatus({ tasks, reminders: [], memories: [], documents: [] }, { ...limits, tasks: 3 }, now).tasks,
    ).toBe("3+ open tasks");
  });
});

describe("api client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("turns an error body into ApiError with its code and message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: { code: "conflict", message: "This action was already decided.", requestId: "r" } }, { status: 409 }),
      ),
    );
    const error = await apiRequest("/api/actions/x/decision").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "conflict", message: "This action was already decided." });
  });

  it("reports network failures without the raw error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(apiRequest("/api/memories")).rejects.toMatchObject({ status: 0, code: "network_error" });
  });

  it("sends JSON same-origin without caching", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ id: "m1" }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(sendJson("/api/memories", "POST", { mode: "work", content: "x" })).resolves.toEqual({ id: "m1" });
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ mode: "work", content: "x" }));
  });
});

describe("web app manifest", () => {
  it("has what Android needs to install the app", () => {
    const m = manifest();
    expect(m.display).toBe("standalone");
    expect(m.start_url).toBe("/today");
    const sizes = (m.icons ?? []).map((icon) => `${icon.sizes}:${icon.purpose}`);
    expect(sizes).toEqual(expect.arrayContaining(["192x192:any", "512x512:any", "512x512:maskable"]));
  });

  it("uses the design palette's page colour and does not lock the orientation", () => {
    const m = manifest();
    expect(m.theme_color).toBe("#f4f4f7");
    expect(m.background_color).toBe("#f4f4f7");
    expect(m.orientation).toBeUndefined();
  });
});
