import type { SupabaseClient } from "@supabase/supabase-js";
import { user, type SqlGate } from "./sql-gate";

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function identifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`Unsupported identifier in fake client: ${name}`);
  return name;
}

interface Filter {
  column: string;
  value: unknown;
}

type Reply = { data: unknown; error: { code: string; message: string } | null };

const failure = (error: unknown): Reply => ({
  data: null,
  error: { code: (error as { code?: string }).code ?? "", message: (error as Error).message },
});

/**
 * A Supabase client that runs repository calls in the SQL gate as the
 * signed-in user, so RLS, grants and triggers apply. It supports
 * `from().select().eq().order().limit()`, `from().update().eq().select().maybeSingle()`
 * and `rpc()`. Rows come back through `json_agg` or `to_json`, which is how
 * PostgREST builds its response, so timestamps are strings and NULLs stay
 * NULL, as in production.
 */
export function sqlGateClient(gate: SqlGate, userId: string): SupabaseClient {
  const from = (table: string) => {
    let columns = "*";
    const filters: Filter[] = [];
    let ordering = "";
    let limit: number | null = null;
    let changes: Record<string, unknown> | null = null;
    let single = false;

    const where = (offset: number) =>
      filters.length
        ? `where ${filters.map((filter, index) => `${identifier(filter.column)} = $${index + 1 + offset}`).join(" and ")}`
        : "";

    const runSelect = async (): Promise<Reply> => {
      const sql = `select coalesce(json_agg(t), '[]'::json) as data from (
          select ${columns} from public.${identifier(table)} ${where(0)} ${ordering}
          ${limit === null ? "" : `limit ${limit}`}
        ) t`;
      try {
        const result = await gate.as<{ data: unknown[] }>(user(userId), sql, filters.map((filter) => filter.value));
        return { data: result.rows[0]!.data, error: null };
      } catch (error) {
        return failure(error);
      }
    };

    const runUpdate = async (): Promise<Reply> => {
      const entries = Object.entries(changes ?? {});
      const set = entries.map(([column], index) => `${identifier(column)} = $${index + 1}`).join(", ");
      const sql = `with t as (
          update public.${identifier(table)} set ${set} ${where(entries.length)} returning ${columns}
        ) select coalesce(json_agg(t), '[]'::json) as data from t`;
      try {
        const result = await gate.as<{ data: unknown[] }>(user(userId), sql, [
          ...entries.map(([, value]) => value),
          ...filters.map((filter) => filter.value),
        ]);
        return { data: result.rows[0]!.data, error: null };
      } catch (error) {
        return failure(error);
      }
    };

    const run = async (): Promise<Reply> => {
      const reply = changes ? await runUpdate() : await runSelect();
      if (!single || reply.error) return reply;
      const rows = reply.data as unknown[];
      if (rows.length > 1) return { data: null, error: { code: "PGRST116", message: "more than one row" } };
      return { data: rows[0] ?? null, error: null };
    };

    const builder = {
      select(list: string) {
        columns = list
          .split(",")
          .map((column) => identifier(column.trim()))
          .join(", ");
        return builder;
      },
      update(values: Record<string, unknown>) {
        changes = values;
        return builder;
      },
      eq(column: string, value: unknown) {
        filters.push({ column, value });
        return builder;
      },
      order(column: string, options?: { ascending?: boolean }) {
        ordering = `order by ${identifier(column)} ${options?.ascending === false ? "desc" : "asc"}`;
        return builder;
      },
      limit(count: number) {
        if (!Number.isInteger(count) || count < 0) throw new Error("limit must be a whole number");
        limit = count;
        return builder;
      },
      maybeSingle() {
        single = true;
        return builder;
      },
      then<R1, R2>(
        onFulfilled?: ((value: Reply) => R1 | PromiseLike<R1>) | null,
        onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
      ) {
        return run().then(onFulfilled, onRejected);
      },
    };
    return builder;
  };

  /** Calls a function with named arguments, as PostgREST does. An object argument is sent as jsonb. */
  const rpc = async (name: string, args: Record<string, unknown> = {}): Promise<Reply> => {
    const entries = Object.entries(args);
    const list = entries
      .map(([key, value], index) => `${identifier(key)} => $${index + 1}${value !== null && typeof value === "object" ? "::jsonb" : ""}`)
      .join(", ");
    const params = entries.map(([, value]) => (value !== null && typeof value === "object" ? JSON.stringify(value) : value));
    try {
      const result = await gate.as<{ data: unknown }>(user(userId), `select to_json(public.${identifier(name)}(${list})) as data`, params);
      return { data: result.rows[0]!.data, error: null };
    } catch (error) {
      return failure(error);
    }
  };

  return { from, rpc } as unknown as SupabaseClient;
}
