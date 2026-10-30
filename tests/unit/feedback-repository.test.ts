import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFeedbackRepository } from "@/server/db/feedback";
import { RepositoryError, SchemaMissingError } from "@/server/db/conversations";

function fakeClient(error: { code?: string; message?: string } | null) {
  const inserts: { table: string; row: unknown }[] = [];
  const client = {
    from: (table: string) => ({
      insert: async (row: unknown) => {
        inserts.push({ table, row });
        return { error };
      },
    }),
  } as unknown as SupabaseClient;
  return { client, inserts };
}

describe("feedback repository", () => {
  it("inserts only kind and text, so the database sets the user from the session", async () => {
    const { client, inserts } = fakeClient(null);
    expect(await createFeedbackRepository(client).send({ kind: "slack", text: null })).toBe("sent");
    expect(inserts).toEqual([{ table: "feedback_requests", row: { kind: "slack", text: null } }]);
  });

  it("reads the daily cap of the trigger as rate_limited", async () => {
    const { client } = fakeClient({ code: "54000", message: "feedback request limit reached" });
    expect(await createFeedbackRepository(client).send({ kind: "slack", text: null })).toBe("rate_limited");
  });

  it("throws a schema error when the migration is not applied, and a plain error otherwise, without the text", async () => {
    await expect(createFeedbackRepository(fakeClient({ code: "PGRST205" }).client).send({ kind: "slack", text: null })).rejects.toBeInstanceOf(
      SchemaMissingError,
    );
    const failure = createFeedbackRepository(fakeClient({ code: "23514", message: "secret note" }).client).send({ kind: "other", text: "secret note" });
    await expect(failure).rejects.toBeInstanceOf(RepositoryError);
    await expect(failure).rejects.not.toThrow(/secret/);
  });
});
