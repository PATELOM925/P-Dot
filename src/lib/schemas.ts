import { z } from "zod";
import { MAX_MESSAGE_CHARS } from "./limits";
import type { ChatRequest } from "@/types/api";

const conversationId = z.uuid();

// `.strict()` rejects unknown keys, so a client cannot smuggle in fields such
// as a user ID. Identity always comes from the verified session.
const sendSchema = z
  .object({
    action: z.literal("send"),
    conversationId: conversationId.optional(),
    message: z
      .string()
      .trim()
      .min(1, "Message cannot be empty.")
      .max(MAX_MESSAGE_CHARS, `Message must be at most ${MAX_MESSAGE_CHARS} characters.`),
    webSearch: z.boolean(),
  })
  .strict();

const retrySchema = z
  .object({
    action: z.literal("retry"),
    conversationId,
    webSearch: z.boolean(),
  })
  .strict();

export const chatRequestSchema: z.ZodType<ChatRequest> = z.discriminatedUnion("action", [
  sendSchema,
  retrySchema,
]);

export const emailSchema = z.email("Enter a valid email address.").max(254);

// Supabase Auth (bcrypt) ignores bytes past 72, so cap there to avoid surprises.
export const newPasswordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters.")
  .refine((value) => new TextEncoder().encode(value).length <= 72, {
    message: "Password must be at most 72 bytes.",
  });
