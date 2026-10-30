#!/usr/bin/env node
// Fills the LOCAL Supabase with a demo account and example data, so every screen
// has something to show: tasks, reminders, memories, and two conversations, in
// both Personal and Work mode.
//
//   npm run db:start          (once, needs Docker)
//   npm run seed:local        (safe to run again: it resets this account's data)
//
// Demo login (local only):
//   email:    demo@example.test
//   password: demo-pass-1234
//
// It refuses to run against anything but this machine, so it can never touch a
// hosted project. It uses the local stack's own admin key only to create the
// account; all data is written as the demo user, under the same row-level
// security as the app.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const EMAIL = "demo@example.test";
const PASSWORD = "demo-pass-1234";

function envFileValue(name) {
  try {
    const line = readFileSync(".env.local", "utf8")
      .split(/\r?\n/)
      .find((entry) => entry.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).trim() : undefined;
  } catch {
    return undefined;
  }
}

function localStatus() {
  try {
    const out = execSync("npx supabase status -o json", { stdio: ["ignore", "pipe", "ignore"] }).toString();
    return JSON.parse(out.slice(out.indexOf("{")));
  } catch {
    return {};
  }
}

const status = localStatus();
const url = process.env.SUPABASE_URL ?? envFileValue("NEXT_PUBLIC_SUPABASE_URL") ?? status.API_URL ?? "http://127.0.0.1:54321";
const publishable =
  process.env.SUPABASE_PUBLISHABLE_KEY ?? envFileValue("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY") ?? status.PUBLISHABLE_KEY;
const secret = process.env.SUPABASE_SECRET_KEY ?? status.SECRET_KEY;

if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) {
  console.error(`Refusing to seed ${url}: this script only seeds a local Supabase.`);
  process.exit(1);
}
if (!publishable || !secret) {
  console.error("Could not read the local Supabase keys. Is it running? Try: npm run db:start");
  process.exit(1);
}

const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(url, secret, options);

async function ensureUser() {
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw new Error(`Could not list users: ${error.message}`);
  const existing = data.users.find((user) => user.email === EMAIL);
  if (existing) {
    await admin.auth.admin.updateUserById(existing.id, { password: PASSWORD, email_confirm: true });
    return existing.id;
  }
  const created = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true });
  if (created.error || !created.data.user) throw new Error(`Could not create the demo user: ${created.error?.message}`);
  return created.data.user.id;
}

const hoursFromNow = (hours, atHour) => {
  const date = new Date(Date.now() + hours * 3_600_000);
  if (atHour !== undefined) date.setUTCHours(atHour, 0, 0, 0);
  return date.toISOString();
};

const TASKS = [
  { mode: "personal", title: "Buy flowers for mum", done: false },
  { mode: "personal", title: "Plan dinner for Friday", done: false },
  { mode: "personal", title: "Call the dentist", done: false },
  { mode: "personal", title: "Book train tickets for Saturday", done: true },
  { mode: "personal", title: "Pay the electricity bill", done: true },
  { mode: "work", title: "Review the onboarding pull request", done: false },
  { mode: "work", title: "Prepare slides for the design review", done: false },
  { mode: "work", title: "Send the weekly status update", done: true },
];

const REMINDERS = [
  { mode: "personal", title: "Water the plants", due_at: hoursFromNow(24, 8), status: "scheduled" },
  { mode: "personal", title: "Call mum", due_at: hoursFromNow(48, 18), status: "scheduled" },
  { mode: "personal", title: "Return the library book", due_at: hoursFromNow(-30), status: "done" },
  { mode: "work", title: "Send the Q4 report", due_at: hoursFromNow(24, 9), status: "scheduled" },
  { mode: "work", title: "Book the retro room", due_at: hoursFromNow(72, 10), status: "scheduled" },
];

const MEMORIES = [
  { mode: "personal", content: "Prefers short, practical answers.", status: "active", source: "user" },
  { mode: "personal", content: "Vegetarian; dislikes mushrooms.", status: "active", source: "user" },
  { mode: "personal", content: "Mum's birthday is on 25 October.", status: "active", source: "user" },
  { mode: "personal", content: "Likes a quiet Sunday walk.", status: "proposed", source: "assistant" },
  { mode: "work", content: "Daily stand-up is at 09:30 on weekdays.", status: "active", source: "user" },
  { mode: "work", content: "Status updates go out on Fridays, three bullet points.", status: "active", source: "user" },
];

const CONVERSATIONS = [
  {
    mode: "personal",
    title: "Weekend in Lisbon",
    messages: [
      { role: "user", content: "Help me plan a relaxed weekend in Lisbon. I love food and views." },
      {
        role: "assistant",
        content:
          "Here is a gentle plan. Saturday: a slow breakfast in Alfama, then the miradouros for the views, and dinner near Chiado. Sunday: tram 15 to Belém for pastries, then a riverside walk.",
      },
    ],
  },
  {
    mode: "work",
    title: "Sprint planning notes",
    messages: [
      { role: "user", content: "Help me turn these notes into three priorities for the sprint." },
      {
        role: "assistant",
        content:
          "1. Ship the onboarding changes after review. 2. Fix the flaky export test. 3. Draft the design review slides. Want me to turn these into tasks?",
      },
    ],
  },
];

async function must(label, promise) {
  const { error } = await promise;
  if (error) throw new Error(`${label}: ${error.message}`);
}

async function main() {
  const userId = await ensureUser();

  const user = createClient(url, publishable, options);
  const signIn = await user.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (signIn.error) throw new Error(`Could not sign in as the demo user: ${signIn.error.message}`);

  // Start clean so the script can be run again. Messages go with their conversation.
  for (const table of ["tasks", "reminders", "memories", "conversations"]) {
    await must(`clear ${table}`, user.from(table).delete().eq("user_id", userId));
  }

  await must("tasks", user.from("tasks").insert(TASKS.map((row) => ({ ...row, user_id: userId }))));
  await must("reminders", user.from("reminders").insert(REMINDERS.map((row) => ({ ...row, user_id: userId }))));
  await must("memories", user.from("memories").insert(MEMORIES.map((row) => ({ ...row, user_id: userId }))));

  for (const conversation of CONVERSATIONS) {
    const created = await user
      .from("conversations")
      .insert({ user_id: userId, mode: conversation.mode, title: conversation.title })
      .select("id")
      .single();
    if (created.error) throw new Error(`conversation: ${created.error.message}`);
    // One insert per message, in order, so created_at keeps the conversation order.
    for (const message of conversation.messages) {
      await must(
        "message",
        user.from("messages").insert({ conversation_id: created.data.id, user_id: userId, ...message }),
      );
    }
  }

  console.log(`Seeded ${url}`);
  console.log(`  ${TASKS.length} tasks, ${REMINDERS.length} reminders, ${MEMORIES.length} memories, ${CONVERSATIONS.length} conversations`);
  console.log(`  Sign in at http://localhost:3000/login as ${EMAIL} (password is at the top of scripts/seed-local.mjs)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
