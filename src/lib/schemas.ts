import { z } from "zod";
import { MCP_SERVER_IDS } from "./connectors";
import { DOCUMENT_MEDIA_TYPES } from "./document-types";
import {
  MAX_ACTION_SUMMARY_CHARS,
  MAX_DOCUMENT_CHARS,
  MAX_DOCUMENT_TITLE_CHARS,
  MAX_EMAIL_ADDRESS_CHARS,
  MAX_EMAIL_BODY_CHARS,
  MAX_EMAIL_RECIPIENTS,
  MAX_EMAIL_RECIPIENTS_TOTAL_CHARS,
  MAX_EMAIL_SUBJECT_CHARS,
  MAX_EVENT_ATTENDEES,
  MAX_EVENT_DAYS,
  MAX_EVENT_TITLE_CHARS,
  MAX_IMAGE_TEXT_BODY_BYTES,
  MAX_MEMORY_CHARS,
  MAX_MESSAGE_CHARS,
  MAX_REMINDER_TITLE_CHARS,
  MAX_TASK_CHARS,
  MAX_TITLE_CHARS,
} from "./limits";
import { EFFORTS } from "./routing";
import { MAX_TIME_ZONE_CHARS, isValidTimeZone } from "./time-zone";
import type { ChatRequest } from "@/types/api";

const conversationId = z.uuid();

export const modeSchema = z.enum(["personal", "work"]);

/** "auto" lets the router choose; "deep" asks for the heavy tier. */
const effortSchema = z.enum(EFFORTS).optional();

/** Apps to read for one message (decision 0016): unique, at most all three. */
const connectorsSchema = z
  .array(z.enum(MCP_SERVER_IDS))
  .max(MCP_SERVER_IDS.length)
  .refine((ids) => new Set(ids).size === ids.length, "Each app can be listed once.")
  .optional();
/**
 * At most one source for each message: web search, Google or connected apps
 * (decisions 0014 and 0016). Several apps together are one source.
 */
const oneSource = (value: { webSearch: boolean; connectors?: unknown[]; useGoogle?: true }) =>
  [value.webSearch, (value.connectors?.length ?? 0) > 0, value.useGoogle === true].filter(Boolean).length <= 1;
/** The browser's IANA time zone, so the reply reads "tomorrow at 6pm" in the user's time. */
const timeZoneSchema = z.string().max(MAX_TIME_ZONE_CHARS).refine(isValidTimeZone, "Unknown time zone.").optional();
const mixedSources = { message: "Use only one of web search, Google or connected apps for a message.", path: ["webSearch"] };

// `.strict()` rejects unknown keys, so a client cannot smuggle in fields such
// as a user ID. Identity always comes from the verified session.
const sendSchema = z
  .object({
    action: z.literal("send"),
    conversationId: conversationId.optional(),
    mode: modeSchema.optional(),
    message: z
      .string()
      .trim()
      .min(1, "Message cannot be empty.")
      .max(MAX_MESSAGE_CHARS, `Message must be at most ${MAX_MESSAGE_CHARS} characters.`),
    webSearch: z.boolean(),
    effort: effortSchema,
    // Only sent when the "Use Google" toggle is on (decision 0014), so an older server still accepts a send without it.
    useGoogle: z.literal(true).optional(),
    connectors: connectorsSchema,
    timeZone: timeZoneSchema,
  })
  .strict()
  .refine(oneSource, mixedSources);

const retrySchema = z
  .object({
    action: z.literal("retry"),
    conversationId,
    webSearch: z.boolean(),
    effort: effortSchema,
    useGoogle: z.literal(true).optional(),
    connectors: connectorsSchema,
    timeZone: timeZoneSchema,
  })
  .strict()
  .refine(oneSource, mixedSources);

export const chatRequestSchema: z.ZodType<ChatRequest> = z.discriminatedUnion("action", [
  sendSchema,
  retrySchema,
]);

export const renameConversationSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, "Name cannot be empty.")
      .max(MAX_TITLE_CHARS, `Name must be at most ${MAX_TITLE_CHARS} characters.`),
  })
  .strict();

const taskTitle = z
  .string()
  .trim()
  .min(1, "Task cannot be empty.")
  .max(MAX_TASK_CHARS, `Task must be at most ${MAX_TASK_CHARS} characters.`);

export const createTaskSchema = z.object({ mode: modeSchema, title: taskTitle }).strict();

export const updateTaskSchema = z
  .object({ title: taskTitle.optional(), done: z.boolean().optional() })
  .strict()
  .refine((value) => value.title !== undefined || value.done !== undefined, {
    message: "Nothing to update.",
  });

export const emailSchema = z.email("Enter a valid email address.").max(254);

// Supabase Auth (bcrypt) ignores bytes past 72, so cap there to avoid surprises.
export const newPasswordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters.")
  .refine((value) => new TextEncoder().encode(value).length <= 72, {
    message: "Password must be at most 72 bytes.",
  });

// ---------------------------------------------------------------------------
// Memory, documents, action proposals and reminders (decision 0009).
// ---------------------------------------------------------------------------

const memoryContent = z
  .string()
  .trim()
  .min(1, "Memory cannot be empty.")
  .max(MAX_MEMORY_CHARS, `Memory must be at most ${MAX_MEMORY_CHARS} characters.`);

export const createMemorySchema = z.object({ mode: modeSchema, content: memoryContent }).strict();

/** Edit the text or mode, or approve a proposed memory (status "active"). */
export const updateMemorySchema = z
  .object({ content: memoryContent.optional(), mode: modeSchema.optional(), status: z.literal("active").optional() })
  .strict()
  .refine((v) => v.content !== undefined || v.mode !== undefined || v.status !== undefined, {
    message: "Nothing to update.",
  });

export const createDocumentSchema = z
  .object({
    mode: modeSchema,
    title: z
      .string()
      .trim()
      .min(1, "Title cannot be empty.")
      .max(MAX_DOCUMENT_TITLE_CHARS, `Title must be at most ${MAX_DOCUMENT_TITLE_CHARS} characters.`),
    mediaType: z.enum(DOCUMENT_MEDIA_TYPES),
    text: z
      .string()
      .min(1, "The document is empty.")
      .max(MAX_DOCUMENT_CHARS, `The document must be at most ${MAX_DOCUMENT_CHARS} characters.`)
      .refine((t) => t.trim().length > 0, { message: "The document is empty." }),
  })
  .strict();

/** A JPEG data URL that starts with the JPEG signature (FF D8 FF, "/9j/" in base64). The browser makes this copy. */
const JPEG_DATA_URL = /^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]*={0,2}$/;

export const imageTextSchema = z
  .object({
    image: z
      .string()
      .max(MAX_IMAGE_TEXT_BODY_BYTES, "This image is too large to read. Try a smaller image.")
      .regex(JPEG_DATA_URL, "Send the image as a JPEG data URL."),
  })
  .strict();

const reminderTitle = z
  .string()
  .trim()
  .min(1, "Reminder cannot be empty.")
  .max(MAX_REMINDER_TITLE_CHARS, `Reminder must be at most ${MAX_REMINDER_TITLE_CHARS} characters.`);

/** An ISO 8601 date-time with a time zone offset, for example 2026-10-30T17:00:00Z. */
const dueAt = z.iso.datetime({ offset: true, message: "Use a date and time, for example 2026-10-30T17:00:00Z." });

export const createReminderSchema = z.object({ mode: modeSchema, title: reminderTitle, dueAt }).strict();

export const updateReminderSchema = z
  .object({
    title: reminderTitle.optional(),
    dueAt: dueAt.optional(),
    status: z.enum(["scheduled", "done", "cancelled"]).optional(),
  })
  .strict()
  .refine((v) => v.title !== undefined || v.dueAt !== undefined || v.status !== undefined, {
    message: "Nothing to update.",
  });

/** The WHATWG email form with a dot in the domain, as in the database check. ASCII only: no space, CR or LF. */
const EMAIL_ADDRESS =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const emailAddress = z
  .string()
  .trim()
  .max(MAX_EMAIL_ADDRESS_CHARS, "An email address is too long.")
  .regex(EMAIL_ADDRESS, "Use a full email address, for example sam@example.com.");
const oneLine = (max: number, name: string) =>
  z
    .string()
    .trim()
    .min(1, `${name} cannot be empty.`)
    .max(max, `${name} must be at most ${max} characters.`)
    .refine((value) => !CONTROL.test(value), { message: `${name} must be one line.` });

const sendEmailPayload = z
  .object({
    kind: z.literal("send_email"),
    mode: modeSchema,
    to: z
      .array(emailAddress)
      .min(1, "Add a recipient.")
      .max(MAX_EMAIL_RECIPIENTS, `At most ${MAX_EMAIL_RECIPIENTS} recipients.`)
      .refine((list) => list.join(", ").length <= MAX_EMAIL_RECIPIENTS_TOTAL_CHARS, {
        message: `The recipients must be at most ${MAX_EMAIL_RECIPIENTS_TOTAL_CHARS} characters together.`,
      }),
    subject: oneLine(MAX_EMAIL_SUBJECT_CHARS, "The subject"),
    body: z
      .string()
      .trim()
      .min(1, "The email cannot be empty.")
      .max(MAX_EMAIL_BODY_CHARS, `The email must be at most ${MAX_EMAIL_BODY_CHARS} characters.`),
  })
  .strict();

const calendarEventPayload = z
  .object({
    kind: z.literal("create_calendar_event"),
    mode: modeSchema,
    title: oneLine(MAX_EVENT_TITLE_CHARS, "The title"),
    start: dueAt,
    end: dueAt,
    attendees: z.array(emailAddress).max(MAX_EVENT_ATTENDEES, `At most ${MAX_EVENT_ATTENDEES} attendees.`),
  })
  .strict()
  .refine((v) => Date.parse(v.end) > Date.parse(v.start), { message: "The end must be after the start." })
  .refine((v) => Date.parse(v.end) - Date.parse(v.start) <= MAX_EVENT_DAYS * 86_400_000, {
    message: `An event can be at most ${MAX_EVENT_DAYS} days long.`,
  });

/** The payload of an action proposal. Also used to validate an edited payload on approval. */
export const actionPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create_task"), mode: modeSchema, title: taskTitle }).strict(),
  z.object({ kind: z.literal("create_reminder"), mode: modeSchema, title: reminderTitle, dueAt }).strict(),
  z.object({ kind: z.literal("save_memory"), mode: modeSchema, content: memoryContent }).strict(),
  sendEmailPayload,
  calendarEventPayload,
]);

/** POST /api/actions/:id/recover. No answer: try to finish again. An answer: the user says if it happened. */
export const actionRecoverSchema = z.object({ answer: z.enum(["done", "not_done"]).optional() }).strict();

/** POST /api/actions/:id/decision. An edited payload must keep the same kind. */
export const actionDecisionSchema = z
  .object({ decision: z.enum(["approve", "reject"]), payload: actionPayloadSchema.optional() })
  .strict()
  .refine((v) => v.decision === "approve" || v.payload === undefined, {
    message: "Only an approval can change the payload.",
  });

export const actionSummarySchema = z.string().trim().min(1).max(MAX_ACTION_SUMMARY_CHARS);
