#!/usr/bin/env node
/**
 * Posts a Discord message listing translation keys that were added to en-GB.json,
 * then creates a thread on that message for translator questions.
 *
 * Env:
 *   OLD_FILE             path to the previous version of the locale file (missing => treated as {})
 *   NEW_FILE             path to the current version
 *   DISCORD_BOT_TOKEN    bot token (needs View Channel / Send Messages / Create Public Threads)
 *   DISCORD_CHANNEL_ID   channel to post in
 *   DISCORD_ROLE_ID      role to ping
 *   EMOJI_PREFIX         e.g. "<:notice1:123456789012345678><:notice2:123456789012345678>"
 *   DRY_RUN              "true" to print the message instead of sending it
 */

const API = "https://discord.com/api/v10";
const MAX_LEN = 2000;
const MAX_VALUE_CHARS = 250;

const {
  OLD_FILE,
  NEW_FILE,
  DISCORD_BOT_TOKEN,
  DISCORD_CHANNEL_ID,
  DISCORD_ROLE_ID,
  EMOJI_PREFIX = "",
  DRY_RUN,
} = process.env;

const dryRun = DRY_RUN === "true";

// --- load + flatten -------------------------------------------------------

import { readFile } from "node:fs/promises";

async function load(path) {
  if (!path) return {};
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {}; // file didn't exist in the base commit
    throw err;
  }
}

// The file mixes flat dot-notation keys with nested objects (and has one ""
// key at the root), so both shapes collapse to the same dotted path here.
function flatten(obj, prefix = "", out = {}) {
  for (const [key, value] of Object.entries(obj ?? {})) {
    const path = prefix && key ? `${prefix}.${key}` : prefix || key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      flatten(value, path, out);
    } else {
      out[path] = value;
    }
  }
  return out;
}

// --- formatting -----------------------------------------------------------

function code(raw) {
  let value = String(raw ?? "")
    .replace(/\r?\n/g, "\\n")
    .trim();
  if (value.length > MAX_VALUE_CHARS) value = `${value.slice(0, MAX_VALUE_CHARS - 1)}…`;
  if (value === "") return "`(empty)`";
  // Use ``double`` fences when the string itself contains a backtick.
  const fence = value.includes("`") ? "``" : "`";
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${pad}${value}${pad}${fence}`;
}

function chunk(lines, firstBudget, restBudget) {
  const chunks = [];
  let current = [];
  let budget = firstBudget;
  let length = 0;
  for (const line of lines) {
    const cost = line.length + 1;
    if (current.length && length + cost > budget) {
      chunks.push(current);
      current = [];
      length = 0;
      budget = restBudget;
    }
    current.push(line);
    length += cost;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

// --- discord --------------------------------------------------------------

async function discord(path, body, method = "POST") {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (res.status === 429) {
      const { retry_after: retryAfter = 1 } = await res.json().catch(() => ({}));
      await new Promise((r) => setTimeout(r, (retryAfter + 0.5) * 1000));
      continue;
    }
    if (!res.ok) {
      throw new Error(`Discord ${method} ${path} -> ${res.status}: ${await res.text()}`);
    }
    return res.json();
  }
  throw new Error(`Discord ${method} ${path}: rate limited after 5 attempts`);
}

// --- main -----------------------------------------------------------------

const before = flatten(await load(OLD_FILE));
const after = flatten(await load(NEW_FILE));

const added = Object.keys(after).filter((key) => !(key in before));

if (added.length === 0) {
  console.log("No new translation strings — nothing to post.");
  process.exit(0);
}

console.log(`Found ${added.length} new string(s).`);

const header = [
  `## ${EMOJI_PREFIX} <@&${DISCORD_ROLE_ID}>`,
  "",
  `The following translation string${added.length === 1 ? " has" : "s have"} been added:`,
  "",
].join("\n");

const footer = "\n\nAny queries/questions, please respond in the thread attached";

const lines = added.map((key) => `- \`${key}\`: ${code(after[key])}`);

const batches = chunk(
  lines,
  MAX_LEN - header.length - footer.length,
  MAX_LEN - 100, // continuation posts go in the thread
);

const first = header + batches[0].join("\n") + footer;
const overflow = batches.slice(1).map((batch) => batch.join("\n"));

if (dryRun) {
  console.log("----- message -----");
  console.log(first);
  overflow.forEach((text, i) => console.log(`----- thread post ${i + 1} -----\n${text}`));
  process.exit(0);
}

const message = await discord(`/channels/${DISCORD_CHANNEL_ID}/messages`, {
  content: first,
  allowed_mentions: { parse: [], roles: [DISCORD_ROLE_ID] },
});

const stamp = new Date().toLocaleDateString("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const thread = await discord(
  `/channels/${DISCORD_CHANNEL_ID}/messages/${message.id}/threads`,
  {
    name: `New strings — ${stamp}`.slice(0, 100),
    auto_archive_duration: 10080, // 7 days
  },
);

for (const text of overflow) {
  await discord(`/channels/${thread.id}/messages`, {
    content: text,
    allowed_mentions: { parse: [] },
  });
}

console.log(`Posted message ${message.id} and opened thread ${thread.id}.`);
