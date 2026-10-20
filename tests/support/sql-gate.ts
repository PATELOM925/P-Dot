import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite, type Results, type Transaction } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

export const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

/** Migration files in the order Supabase applies them (by name). */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

/**
 * Stand-ins for what a Supabase project has before the first migration runs.
 * The default privileges are the legacy Supabase set, copied from
 * github.com/supabase/postgres migrations/db/init-scripts/00000000000000-initial-schema.sql.
 * This is the most permissive case: every grant a migration does not revoke stays open.
 */
const SUPABASE_BOOTSTRAP = `
  set timezone to 'UTC';
  create role anon nologin noinherit;
  create role authenticated nologin noinherit;
  create role service_role nologin noinherit bypassrls;

  create schema auth;
  create schema extensions;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $$;
  grant usage on schema auth to anon, authenticated, service_role;

  grant usage on schema public to anon, authenticated, service_role;
  grant usage on schema extensions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

export type Actor = { role: "anon" } | { role: "authenticated"; userId: string };

export interface SqlGate {
  /** Runs as the migration owner (superuser here). Bypasses RLS: use it only to seed and to check. */
  admin<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<Results<T>>;
  /** Runs one statement in its own transaction as the actor, the way PostgREST does for each request. */
  as<T = Record<string, unknown>>(actor: Actor, sql: string, params?: unknown[]): Promise<Results<T>>;
  /** Runs several statements in one transaction as the actor. */
  transactionAs<T>(actor: Actor, fn: (tx: Transaction) => Promise<T>): Promise<T>;
  createUser(): Promise<string>;
  close(): Promise<void>;
}

export const anon: Actor = { role: "anon" };
export const user = (userId: string): Actor => ({ role: "authenticated", userId });

async function enterRole(tx: Transaction, actor: Actor): Promise<void> {
  await tx.exec(`set local role ${actor.role}`);
  const claims = actor.role === "authenticated" ? { sub: actor.userId, role: "authenticated" } : { role: "anon" };
  await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
}

/** Starts an in-memory Postgres, applies the Supabase stand-ins, then every migration unchanged. */
export async function startSqlGate(): Promise<SqlGate> {
  const pg = await PGlite.create({ extensions: { vector } });
  await pg.exec(SUPABASE_BOOTSTRAP);
  for (const file of migrationFiles()) {
    try {
      await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    } catch (error) {
      throw new Error(`Migration ${file} did not apply: ${(error as Error).message}`);
    }
  }

  const transactionAs = <T>(actor: Actor, fn: (tx: Transaction) => Promise<T>) =>
    pg.transaction(async (tx) => {
      await enterRole(tx, actor);
      return fn(tx);
    });

  return {
    admin: (sql, params) => pg.query(sql, params),
    as: (actor, sql, params) => transactionAs(actor, (tx) => tx.query(sql, params)),
    transactionAs,
    async createUser() {
      const result = await pg.query<{ id: string }>("insert into auth.users (id) values (gen_random_uuid()) returning id");
      return result.rows[0]!.id;
    },
    close: () => pg.close(),
  };
}

/**
 * Proves that the default privileges in the bootstrap are live, so a check
 * that passes cannot pass only because the stand-in grants nothing.
 * Returns the privileges anon and authenticated got on a new table.
 */
export async function defaultGrantsOnNewTable(gate: SqlGate): Promise<Record<string, string[]>> {
  await gate.admin("create table public.sql_gate_sentinel (id int)");
  try {
    const result = await gate.admin<{ grantee: string; privilege_type: string }>(
      `select grantee, privilege_type from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'sql_gate_sentinel'
          and grantee in ('anon', 'authenticated', 'service_role')
        order by grantee, privilege_type`,
    );
    const grants: Record<string, string[]> = {};
    for (const row of result.rows) (grants[row.grantee] ??= []).push(row.privilege_type);
    return grants;
  } finally {
    await gate.admin("drop table public.sql_gate_sentinel");
  }
}

/** Returns the Postgres error code that `run` threw, or null when it succeeded. */
export async function errorCode(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code !== "string") throw error;
    return code;
  }
}
