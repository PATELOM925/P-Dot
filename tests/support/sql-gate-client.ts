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

/**
 * A Supabase client for repository read tests. It supports only
 * `from().select().eq().order().limit()` and runs the query in the SQL gate as
 * the signed-in user, so RLS and grants apply. Rows come back through
 * `json_agg`, which is how PostgREST builds its response, so timestamps are
 * strings and NULLs stay NULL, as in production.
 */
export function sqlGateClient(gate: SqlGate, userId: string): SupabaseClient {
  const from = (table: string) => {
    let columns = "*";
    const filters: Filter[] = [];
    let ordering = "";
    let limit: number | null = null;

    const run = async () => {
      const params = filters.map((filter) => filter.value);
      const where = filters.length
        ? `where ${filters.map((filter, index) => `${identifier(filter.column)} = $${index + 1}`).join(" and ")}`
        : "";
      const sql = `select coalesce(json_agg(t), '[]'::json) as data from (
          select ${columns} from public.${identifier(table)} ${where} ${ordering}
          ${limit === null ? "" : `limit ${limit}`}
        ) t`;
      try {
        const result = await gate.as<{ data: unknown[] }>(user(userId), sql, params);
        return { data: result.rows[0]!.data, error: null };
      } catch (error) {
        return { data: null, error: { code: (error as { code?: string }).code ?? "", message: (error as Error).message } };
      }
    };

    const builder = {
      select(list: string) {
        columns = list
          .split(",")
          .map((column) => identifier(column.trim()))
          .join(", ");
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
      then<R1, R2>(
        onFulfilled?: ((value: Awaited<ReturnType<typeof run>>) => R1 | PromiseLike<R1>) | null,
        onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
      ) {
        return run().then(onFulfilled, onRejected);
      },
    };
    return builder;
  };

  return { from } as unknown as SupabaseClient;
}
