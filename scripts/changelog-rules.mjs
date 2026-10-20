// Rules for each top-level entry under "## Unreleased" in CHANGELOG.md (AGENTS.md, pull requests section).
// Dated sections are not checked: entries from before this check use an older shape.

const REPO = "https://github.com/PATELOM925/P-Dot";
const PR_LINK = /https:\/\/github\.com\/PATELOM925\/P-Dot\/pull\/\d+(?![\d#])/;
const COMMIT_LINK = /https:\/\/github\.com\/PATELOM925\/P-Dot\/commit\/[0-9a-f]{7,40}(?![0-9a-zA-Z])/;
const TITLE = /^- \*\*(.+?)\*\*/;

function labelStatus(lines, label) {
  const [first, ...rest] = lines;
  const onTitleLine = new RegExp(`\\*\\*.*\\s${label}:\\s*(\\S?)`).exec(first.text);
  if (onTitleLine) return onTitleLine[1] ? null : "empty";
  const index = rest.findIndex((line) => new RegExp(`^\\s+- ${label}:`).test(line.text));
  if (index === -1) return "missing";
  const line = rest[index];
  const text = line.text.replace(new RegExp(`^\\s+- ${label}:`), "").trim();
  if (text) return null;
  const indent = line.text.search(/\S/);
  const child = rest[index + 1];
  return child && child.text.search(/\S/) > indent && child.text.trim().startsWith("-") ? null : "empty";
}

function checkEntry(lines) {
  const first = lines[0];
  const title = TITLE.exec(first.text)?.[1] ?? first.text.slice(2, 62).trim();
  const at = `CHANGELOG entry "${title}" (line ${first.number})`;
  const errors = [];
  const add = (message) => errors.push({ line: first.number, title, message: `${at}: ${message}` });

  if (!TITLE.test(first.text)) add('start the entry with a bold title: "- **What changed.**".');
  for (const label of ["Problem", "Resolution"]) {
    const result = labelStatus(lines, label);
    if (result === "missing")
      add(`add a "${label}:" line, as a sub-bullet "  - ${label}: ..." or after the bold title on the same line.`);
    if (result === "empty") add(`the "${label}:" line is empty. Write the ${label.toLowerCase()} after the label.`);
  }

  const body = lines.map((line) => line.text).join("\n");
  if (/PR:\s*not opened yet/i.test(body))
    add(`replace "PR: not opened yet" with the pull request link (${REPO}/pull/N). Open the pull request first.`);
  else if (!PR_LINK.test(body) && !COMMIT_LINK.test(body))
    add(
      `add a link to the pull request (${REPO}/pull/N), or, if there was no pull request, to the commit (${REPO}/commit/<sha>). A link to a review comment does not count.`,
    );
  return errors;
}

export function findChangelogErrors(text) {
  const all = text.split(/\r?\n/).map((line, i) => ({ text: line, number: i + 1 }));
  const start = all.findIndex((line) => /^## Unreleased\s*$/.test(line.text));
  if (start === -1)
    return [{ line: 1, title: "", message: 'CHANGELOG.md has no "## Unreleased" section. Add it above the newest dated section.' }];

  const section = [];
  for (const line of all.slice(start + 1)) {
    if (/^## /.test(line.text)) break;
    section.push(line);
  }

  const entries = [];
  let current = null;
  for (const line of section) {
    if (/^- /.test(line.text)) {
      current = [line];
      entries.push(current);
    } else if (/^#/.test(line.text)) {
      current = null;
    } else if (current && (line.text.trim() === "" || /^\s/.test(line.text))) {
      current.push(line);
    } else if (line.text.trim() !== "") {
      current = null;
    }
  }
  return entries.flatMap(checkEntry);
}
