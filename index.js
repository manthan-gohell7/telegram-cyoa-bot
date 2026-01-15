import express from "express";
import { Telegraf } from "telegraf";
import axios from "axios";
import { google } from "googleapis";

/* =====================
   ENV
===================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const SHEET_ID = process.env.SHEET_ID;
const PORT = process.env.PORT || 3000;

/* =====================
   CONSTANTS
===================== */
const ADMIN_GROUP_ID = "-5127338138";
const MAX_PLAYERS = 1;

/* =====================
   WORLD CANON (IMMUTABLE)
===================== */
const WORLD_CANON = `
WORLD NAME: Astra Mare
ERA: The Era of Will

POWER & RULES:
- No Devil Fruits exist.
- Power comes from Will (Haki), Magic (Knights), Anti-Magic, and Reader Awareness.
- Haki grows through conviction, battle, and resolve.
- Magic is regulated by Knight Orders.
- Anti-Magic rejects the system itself and harms its user.
- Readers sense narrative turning points but cannot freely control fate.

HISTORY:
- Age 0: Primordial Era — magic overflow destroyed balance.
- Age 1: Age of Order — Knight Orders regulated magic.
- Age 2: Era of Will — Haki awakened and terrified the Knights.

FACTIONS:
- Knight Orders (Order & Control)
- Free Willers (Freedom & Haki)
- Anti-Magic Survivors (Anomalies)
- Hidden Observers (ORV logic)

PLAYER ARCHETYPES:
- Player 1: Conqueror / Leader (Will King)
- Player 2: Anti-Magic Breaker (Demon existence MUST remain hidden early)
- Player 3: Reader / Strategist (Narrative awareness)

SPOILER RULE:
- The Anti-Magic demon must NOT be revealed early.
- Only hints are allowed. Full reveal is mid-story only.

FAIRNESS RULE:
- Treat all players equally.
- No favoritism.
- Spotlight rotates naturally.

CONTINUITY RULE:
- Story must progress gradually and logically.
- No sudden power jumps.
- No nonsensical twists.
`;

/* =====================
   TELEGRAM
===================== */
const bot = new Telegraf(BOT_TOKEN);

/* =====================
   EXPRESS
===================== */
const app = express();
app.use(express.json());

/* =====================
   GOOGLE SHEETS
===================== */
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});

const sheets = google.sheets({ version: "v4", auth });

/* =====================
   SHEET HELPERS
===================== */
async function read(range) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range
  });
  return res.data.values || [];
}

async function write(range, values) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "RAW",
    requestBody: { values }
  });
}

/* =====================
   STATE HELPERS
===================== */
async function getMeta() {
  const rows = await read("meta!A:B");
  return Object.fromEntries(rows.slice(1));
}

async function setMeta(key, value) {
  const rows = await read("meta!A:B");
  const index = rows.findIndex(r => r[0] === key);
  if (index !== -1) {
    await write(`meta!B${index + 1}`, [[value]]);
  }
}

async function getPlayers() {
  const rows = await read("players!A:D");
  return rows.slice(1).map(r => ({
  userId: r[0],
  characterName: r[1],
  hasPlayed: r[2] === "TRUE",
  prompt: r[3] || ""
}));
}

async function updatePlayer(userId, data) {
  const rows = await read("players!A:D");
  const index = rows.findIndex(r => r[0] == userId);
  if (index === -1) return;

  const row = rows[index];
  await write(`players!A${index + 1}:D${index + 1}`, [[
    row[0],
    row[1],
    data.hasPlayed ?? row[2],
    data.prompt ?? row[3]
  ]]);
}

/* =====================
   GROQ CALL
===================== */
async function callGroq(systemPrompt, userPrompt) {
  const res = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: "llama-3.3-70b-versatile",
      temperature: 0.7,
      max_tokens: 900,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );
  return res.data.choices[0].message.content;
}

bot.command("groupid", ctx => {
  ctx.reply(String(ctx.chat.id));
});

/* =====================
   /help (DM + GROUP)
===================== */
bot.command("help", async ctx => {
  await ctx.reply(`
🎮 CYOA — ASTRA MARE

🧍 PLAYERS (DM)
- /start → Register
- Send ONE action when it's your turn

👥 GROUP
- Shows world updates only
- Commands only, no free text

🔁 TURN FLOW
- Players act one by one
- After all act → world updates
- Turns announced after each update

📌 RULES
- DM for actions
- Group for story
- Fate enforces fairness
`);
});

/* =====================
   /init (GROUP ONLY)
===================== */

async function clearSheet(range) {
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range
  });
}

bot.command("init", async ctx => {
  if (String(ctx.chat.id) !== ADMIN_GROUP_ID) return;

  // HARD CLEAR all data
  await clearSheet("meta!A:Z");
  await clearSheet("players!A:Z");
  await clearSheet("config!A:Z");

  // Recreate meta
  await write("meta!A1:B5", [
  ["key", "value"],
  ["phase", "1"],
  ["current_turn", ""],
  ["world_state", "The world has not yet begun."],
  ["pending_character", ""]
]);

  // Recreate players header
  await write("players!A1:D1", [
  ["user_id", "character_name", "has_played", "last_prompt"]
]);

  // Recreate config
  await write("config!A1:B2", [
    ["key", "value"],
    ["max_players", String(MAX_PLAYERS)]
  ]);

  await ctx.reply(
    "🌍 The world has been re-conceptualized.\nAll previous souls have been erased.\nAwaiting new souls..."
  );
});


/* =====================
   /start (DM REGISTRATION)
===================== */

async function setPendingCharacter(userId) {
  await setMeta("pending_character", String(userId));
}

async function clearPendingCharacter() {
  await setMeta("pending_character", "");
}

bot.start(async ctx => {
  if (ctx.chat.type !== "private") return;

  const players = await getPlayers();

  if (players.find(p => p.userId == ctx.from.id)) {
    return ctx.reply("🧭 Your soul already resides in the world.");
  }

  await setPendingCharacter(ctx.from.id);

  await ctx.reply(
    "🧙 You stand at the edge of Astra Mare.\n\nWhat is the name of your character?"
  );
});

/* =====================
   WORLD INTRO
===================== */
async function startWorldIntro() {
  const players = await getPlayers();

  const intro = await callGroq(
    `You are the GOD of Astra Mare.\n${WORLD_CANON}`,
    "Introduce the world, factions, and mystery. Do not spoil hidden truths."
  );

  await bot.telegram.sendMessage(
    ADMIN_GROUP_ID,
    `🌍 WORLD BEGINS\n\n${intro}`
  );

  for (const p of players) {
    const personal = await callGroq(
      `You are the GOD of Astra Mare.\n${WORLD_CANON}`,
      `Write a personal opening scene ONLY for ${p.characterName}.`
    );
    await bot.telegram.sendMessage(p.userId, personal);
  }

  await setMeta("current_turn", players[0].userId);

  await bot.telegram.sendMessage(
    ADMIN_GROUP_ID,
    `🔁 CURRENT TURN → ${players[0].characterName}`
  );
}

/* =====================
   DM TURN INPUT
===================== */
bot.on("text", async ctx => {
  if (ctx.message.text.startsWith("/")) return;
  if (ctx.chat.type !== "private") return;

  const meta = await getMeta();

  /* =====================
     CHARACTER NAME REGISTRATION (MUST BE FIRST)
  ===================== */
  if (meta.pending_character === String(ctx.from.id)) {
    const characterName = ctx.message.text.trim();

    if (characterName.length < 2 || characterName.length > 30) {
      return ctx.reply("❌ Character name must be 2–30 characters long.");
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "players!A:D",
      valueInputOption: "RAW",
      requestBody: {
        values: [[ctx.from.id, characterName, "FALSE", ""]]
      }
    });

    await setMeta("pending_character", "");

    const players = await getPlayers();

    const tgName = ctx.from.first_name
        ? `${ctx.from.first_name}`
        : ctx.from.username || "Unknown";

await bot.telegram.sendMessage(
  ADMIN_GROUP_ID,
  `🧍 A new soul enters the world.\n${tgName} → ${characterName} (${players.length}/${MAX_PLAYERS})`
);
    
    await ctx.reply(`✨ Welcome, ${characterName}. Your story begins.`);

    if (players.length === MAX_PLAYERS) {
      await startWorldIntro();
    }

    return; // ⛔ VERY IMPORTANT
  }

  /* =====================
     TURN ENFORCEMENT
  ===================== */
  if (String(ctx.from.id) !== meta.current_turn) {
    return ctx.reply("🌫️ Fate does not yet call upon you.");
  }

  /* =====================
     NORMAL TURN INPUT
  ===================== */
  await updatePlayer(ctx.from.id, {
    hasPlayed: "TRUE",
    prompt: ctx.message.text
  });

  await ctx.reply("✅ Your will has been recorded.");

  const players = await getPlayers();

  if (players.every(p => p.hasPlayed)) {
    await processRound();
  } else {
    const next = players.find(p => !p.hasPlayed);
    await setMeta("current_turn", next.userId);
  }
});

/* =====================
   ROUND RESOLUTION
===================== */
async function processRound() {
  const meta = await getMeta();
  const players = await getPlayers();

  const actions = players.map(p => `${p.characterName}: ${p.prompt}`).join("\n");

  const narration = await callGroq(
    `You are the GOD of Astra Mare.\n${WORLD_CANON}`,
    `Current world state:\n${meta.world_state}\n\nPlayer actions:\n${actions}\n\nNarrate consequences logically. End with [END OF ROUND].`
  );

  if (!narration.includes("[END OF ROUND]")) return;

  const clean = narration.replace("[END OF ROUND]", "").trim();
  await setMeta("world_state", clean);

  for (const p of players) {
    await updatePlayer(p.userId, { hasPlayed: "FALSE", prompt: "" });
  }

  const next = players[0];
  await setMeta("current_turn", next.userId);

  await bot.telegram.sendMessage(
    ADMIN_GROUP_ID,
    `🌍 WORLD UPDATE\n\n${clean}\n\n🔁 NEXT TURN: ${next.characterName}`
  );
}

/* =====================
   WEBHOOK
===================== */
app.post("/webhook", (req, res) => {
  bot.handleUpdate(req.body);
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log("CYOA Astra Mare engine running");
});
