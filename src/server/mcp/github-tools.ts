import "server-only";
import { z } from "zod";
import type { CatalogTool } from "./catalog";
import { StepStop, type StepCaller } from "./steps";

// GitHub requests in plain words (decision 0020): "my open PRs" and "the PDot
// repo". The model gives no free text to GitHub. The user's login comes from
// `get_me`, and P-Dot builds every search query in code from that login, a
// fixed qualifier and, for a repository, a name copied from the user's message.

const loose = <T extends z.ZodRawShape>(shape: T) => z.object(shape).loose();

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const FULL_NAME = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const PER_PAGE = 10;
/** Repositories P-Dot looks through to match a name: the most recently updated ones. */
const REPO_PAGE = 100;
const MAX_RECENT_CLOSED = 5;

const text = (max: number) => z.string().max(max);
const day = (value: string | null | undefined) => (value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null);
const oneLine = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, 200);

/** The signed-in user's login. The same `get_me` call runs once in a turn. */
async function login(caller: StepCaller): Promise<string> {
  const { json } = await caller.call("get_me", {});
  const parsed = loose({ login: text(39) }).safeParse(json);
  if (!parsed.success || !LOGIN.test(parsed.data.login)) throw new StepStop("GitHub did not say who the user is. Nothing more was read.");
  return parsed.data.login;
}

const issueItem = loose({
  number: z.number().int(),
  title: text(1000),
  state: text(20).optional(),
  draft: z.boolean().nullish(),
  html_url: text(500).optional(),
  updated_at: text(40).nullish(),
  pull_request: loose({ merged_at: text(40).nullish() }).nullish(),
});
const searchResult = loose({ total_count: z.number().int().optional(), items: z.array(issueItem).max(100) });

/** "owner/name#12" from an issue or pull request link. */
function itemRef(url: string | undefined, number: number): string {
  const match = url ? /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/\d+/.exec(url) : null;
  return match ? `${match[1]}#${number}` : `#${number}`;
}

function itemLine(item: z.infer<typeof issueItem>): string {
  const state = item.pull_request?.merged_at ? "merged" : item.draft ? "draft" : (item.state ?? "unknown");
  const updated = day(item.updated_at);
  return `- ${itemRef(item.html_url, item.number)}: ${oneLine(item.title)} (${state}${updated ? `, updated ${updated}` : ""})${item.html_url ? ` ${item.html_url}` : ""}`;
}

function searchLines(heading: string, result: { json: unknown; text: string }): string {
  const parsed = searchResult.safeParse(result.json);
  if (!parsed.success) return `${heading}\n${result.text}`;
  const { items, total_count: total } = parsed.data;
  if (items.length === 0) return `${heading}\nNone found.`;
  const count = total !== undefined && total > items.length ? ` (${items.length} of ${total} shown)` : "";
  return [`${heading}${count}`, ...items.slice(0, PER_PAGE).map(itemLine)].join("\n");
}

const MY_WORK_KINDS = ["open_pull_requests", "recent_pull_requests", "recent_issues"] as const;
type MyWorkKind = (typeof MY_WORK_KINDS)[number];

const MY_WORK: Record<MyWorkKind, { remote: string; query: (login: string) => string; heading: (login: string) => string }> = {
  open_pull_requests: {
    remote: "search_pull_requests",
    query: (login) => `is:open author:${login}`,
    heading: (login) => `Open pull requests that ${login} opened, newest update first`,
  },
  recent_pull_requests: {
    remote: "search_pull_requests",
    query: (login) => `involves:${login}`,
    heading: (login) => `Pull requests that ${login} took part in, newest update first`,
  },
  recent_issues: {
    remote: "search_issues",
    query: (login) => `involves:${login}`,
    heading: (login) => `Issues that ${login} took part in, newest update first`,
  },
};

const SEARCH_SENDS = ["query", "sort", "order", "perPage"] as const;

export const githubMyWork: CatalogTool<{ kind: MyWorkKind }> = {
  name: "github_my_work",
  addedLater: true,
  description:
    "The signed-in user's own GitHub work: their open pull requests, or their recent pull requests or issues. Needs no owner or repository.",
  guidance:
    "github_my_work: the user's own GitHub work. Use it for requests such as \"my open PRs\", \"my GitHub\" or \"my recent issues\". kind open_pull_requests: open pull requests that the user opened. recent_pull_requests: pull requests that the user took part in. recent_issues: issues that the user took part in. Do not ask the user for their GitHub name.",
  args: z.object({ kind: z.enum(MY_WORK_KINDS).describe("Which list to get.") }).strict(),
  outbound: { kind: "none" },
  steps: [
    { remote: "get_me", sends: [] },
    { remote: "search_pull_requests", sends: SEARCH_SENDS },
    { remote: "search_issues", sends: SEARCH_SENDS },
  ],
  async run(caller, { kind }) {
    const user = await login(caller);
    const plan = MY_WORK[kind];
    const result = await caller.call(plan.remote, { query: plan.query(user), sort: "updated", order: "desc", perPage: PER_PAGE });
    return `GitHub user: ${user}\n${searchLines(plan.heading(user), result)}`;
  },
  maxCallsPerTurn: 2,
  statusQuery: () => undefined,
};

/** Lower case letters and digits only, so "PDot", "p-dot" and "P Dot" compare equal. */
export function repoNameKey(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

const repoItem = loose({
  full_name: text(200),
  description: text(2000).nullish(),
  private: z.boolean().nullish(),
  archived: z.boolean().nullish(),
  pushed_at: text(40).nullish(),
  updated_at: text(40).nullish(),
  html_url: text(500).nullish(),
});
type RepoItem = z.infer<typeof repoItem>;

/**
 * The repository the name points to: an exact match (the most recently updated
 * one when two names differ only in hyphens or spaces), else the only one whose
 * name contains it. Several partial matches give a list to choose from.
 */
export function matchRepos<T extends { full_name: string }>(wanted: string, repos: readonly T[]): { found: T } | { choices: T[] } {
  const key = repoNameKey(wanted.replace(/\b(repo|repository)\b/gi, "")) || repoNameKey(wanted);
  if (!key) return { choices: [] };
  const nameKey = (repo: T) => repoNameKey(repo.full_name.split("/")[1] ?? "");
  const exact = repos.find((repo) => nameKey(repo) === key);
  if (exact) return { found: exact };
  const partial = key.length >= 3 ? repos.filter((repo) => nameKey(repo).includes(key)) : [];
  return partial.length === 1 ? { found: partial[0]! } : { choices: partial };
}

const pullItem = loose({
  number: z.number().int(),
  title: text(1000),
  state: text(20).optional(),
  draft: z.boolean().nullish(),
  merged: z.boolean().nullish(),
  merged_at: text(40).nullish(),
  closed_at: text(40).nullish(),
  updated_at: text(40).nullish(),
  html_url: text(500).nullish(),
});
const pullList = z.union([
  z.array(pullItem).max(100),
  loose({ pull_requests: z.array(pullItem).max(100) }).transform((value) => value.pull_requests),
  loose({ items: z.array(pullItem).max(100) }).transform((value) => value.items),
]);

function pullLine(pull: z.infer<typeof pullItem>): string {
  const merged = pull.merged || pull.merged_at ? `merged ${day(pull.merged_at) ?? ""}`.trim() : null;
  const state = merged ?? (pull.draft ? "draft" : (pull.state ?? "unknown"));
  const updated = day(pull.updated_at);
  return `- #${pull.number}: ${oneLine(pull.title)} (${state}${updated && !merged ? `, updated ${updated}` : ""})${pull.html_url ? ` ${pull.html_url}` : ""}`;
}

function pullSections(result: { json: unknown; text: string }): string {
  const parsed = pullList.safeParse(result.json);
  if (!parsed.success) return `Pull requests, newest update first:\n${result.text}`;
  const open = parsed.data.filter((pull) => pull.state === "open");
  const closed = parsed.data.filter((pull) => pull.state !== "open").slice(0, MAX_RECENT_CLOSED);
  return [
    `Open pull requests (${open.length}${parsed.data.length >= PER_PAGE * 2 ? " in the 20 most recently updated" : ""}):`,
    ...(open.length > 0 ? open.map(pullLine) : ["None."]),
    "Recent work (closed or merged pull requests, newest first):",
    ...(closed.length > 0 ? closed.map(pullLine) : ["None."]),
  ].join("\n");
}

function repoLine(repo: RepoItem): string {
  const pushed = day(repo.pushed_at) ?? day(repo.updated_at);
  const parts = [repo.private ? "private" : "public", repo.archived ? "archived" : null, pushed ? `last push ${pushed}` : null].filter(Boolean);
  const about = repo.description ? `. ${oneLine(repo.description)}` : "";
  return `${repo.full_name} (${parts.join(", ")})${about}`;
}

export const githubFindRepo: CatalogTool<{ name: string }> = {
  name: "github_find_repo",
  addedLater: true,
  description:
    "Find one of the signed-in user's own GitHub repositories by its name, then list its open pull requests and its recent closed or merged ones.",
  guidance:
    "github_find_repo: find one of the user's own repositories by name, for example \"PDot\" finds P-Dot, and list its open and recent pull requests. Use it when the user names a repository without its owner. The name must be copied word for word from the user's message. You can call it once.",
  args: z
    .object({ name: z.string().trim().min(1).max(100).describe("The repository name, copied from the user's message.") })
    .strict(),
  outbound: { kind: "words", field: "name" },
  steps: [
    { remote: "get_me", sends: [] },
    { remote: "search_repositories", sends: ["query", "sort", "order", "perPage"] },
    { remote: "list_pull_requests", sends: ["owner", "repo", "state", "sort", "direction", "perPage"] },
  ],
  async run(caller, { name }) {
    const user = await login(caller);
    const search = await caller.call("search_repositories", { query: `user:${user} fork:true`, sort: "updated", order: "desc", perPage: REPO_PAGE });
    const parsed = loose({ items: z.array(loose({ full_name: z.unknown() })).max(REPO_PAGE) }).safeParse(search.json);
    if (!parsed.success) throw new StepStop("GitHub sent a list of repositories that P-Dot could not read. Nothing more was read.");
    const repos = parsed.data.items.flatMap((item) => {
      const repo = repoItem.safeParse(item);
      return repo.success && FULL_NAME.test(repo.data.full_name) ? [repo.data] : [];
    });
    const match = matchRepos(name, repos);
    if ("choices" in match) {
      const shown = (match.choices.length > 0 ? match.choices : repos).slice(0, PER_PAGE);
      for (const repo of shown) caller.allowId(repo.full_name);
      const heading =
        match.choices.length > 0
          ? `More than one repository of ${user} has a name like "${name}". Ask the user which one:`
          : `No repository of ${user} has a name like "${name}" (P-Dot looked at the ${REPO_PAGE} most recently updated). Their most recently updated repositories:`;
      return [heading, ...shown.map((repo) => `- ${repoLine(repo)}`)].join("\n");
    }
    const repo = match.found;
    const [owner, repoName] = repo.full_name.split("/") as [string, string];
    caller.allowId(repo.full_name);
    const pulls = await caller.call("list_pull_requests", {
      owner,
      repo: repoName,
      state: "all",
      sort: "updated",
      direction: "desc",
      perPage: PER_PAGE * 2,
    });
    return `Repository: ${repoLine(repo)}${repo.html_url ? ` ${repo.html_url}` : ""}\n${pullSections(pulls)}`;
  },
  maxCallsPerTurn: 1,
  statusQuery: ({ name }) => name,
};
