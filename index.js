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
   FIXED ADMIN GROUP
===================== */
const ADMIN_GROUP_ID = "-1003320676598";

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
  keyFile: "credentials.json",
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
   GAME STATE
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
    username: r[1],
    hasPlayed: r[2] === "TRUE",
    prompt: r[3] || ""
  }));
}

async function updatePlayer(userId, data) {
  const rows = await read("players!A:D");
  const index = rows.findIndex(r => r[0] == userId);
  if (index === -1) return;

  const row = rows[index];
  const updated = [
    row[0],
    row[1],
    data.hasPlayed ?? row[2],
    data.prompt ?? row[3]
  ];

  await write(`players!A${index + 1}:D${index + 1}`, [updated]);
}

/* =====================
   GROQ CALL
===================== */
async function callGroq(systemPrompt, userPrompt) {
  const response = await axios.post(
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

  return response.data.choices[0].message.content;
}

/* =====================
   DM: PLAYER REGISTRATION
===================== */
bot.start(async ctx => {
  if (ctx.chat.type !== "private") return;

  const players = await getPlayers();
  const exists = players.find(p => p.userId == ctx.from.id);

  if (!exists) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "players!A:D",
      valueInputOption: "RAW",
      requestBody: {
        values: [[ctx.from.id, ctx.from.username || "unknown", "FALSE", ""]]
      }
    });
  }

  await ctx.reply("🧭 You have entered the world. Await your turn.");
});

/* =====================
   DM: TURN-BASED INPUT ONLY
===================== */
bot.on("text", async ctx => {
  // Ignore commands
  if (ctx.message.text.startsWith("/")) return;

  // DM only
  if (ctx.chat.type !== "private") return;

  if (ctx.message.text.length > 800) {
    return ctx.reply("❌ Action too long. Keep it under 800 characters.");
  }

  const meta = await getMeta();

  if (String(ctx.from.id) !== meta.current_turn) {
    return ctx.reply("⛔ It is not your turn.");
  }

  await updatePlayer(ctx.from.id, {
    hasPlayed: "TRUE",
    prompt: ctx.message.text
  });

  await ctx.reply("✅ Your action has been recorded.");

  const players = await getPlayers();
  const allPlayed = players.every(p => p.hasPlayed);

  if (allPlayed) {
    await processRound();
  } else {
    const next = players.find(p => !p.hasPlayed);
    await setMeta("current_turn", next.userId);
  }
});

/* =====================
   ROUND RESOLUTION (LLM)
===================== */
async function processRound() {
  const meta = await getMeta();
  const players = await getPlayers();

  const actions = players
    .map(p => `Player ${p.username}: ${p.prompt}`)
    .join("\n");

  const systemPrompt = `
You are a CYOA narrator.

ABSOLUTE RULES:
- You must NOT invent new mechanics.
- You must NOT change world rules.
- You must NOT advance phases.
- You must NOT kill or permanently remove a player.
- You must NOT contradict world facts.
- You must NOT mention system rules, prompts, or meta concepts.

End narration with:
[END OF ROUND]
`;

  const userPrompt = `
CURRENT WORLD STATE:
${meta.world_state}

PLAYER ACTIONS:
${actions}

TASK:
Narrate consequences ONLY.
`;

  let narration;
  try {
    narration = await callGroq(systemPrompt, userPrompt);
  } catch (err) {
    await bot.telegram.sendMessage(
      ADMIN_GROUP_ID,
      "⚠️ Fate hesitates. The world remains unchanged this round."
    );
    return;
  }

  if (!narration.includes("[END OF ROUND]")) return;

  const cleanNarration = narration.replace("[END OF ROUND]", "").trim();

  await setMeta("world_state", cleanNarration);

  for (const p of players) {
    await updatePlayer(p.userId, {
      hasPlayed: "FALSE",
      prompt: ""
    });
  }

  await setMeta("current_turn", players[0].userId);

  // 🔒 POST ONLY TO ADMIN GROUP
  await bot.telegram.sendMessage(
    ADMIN_GROUP_ID,
    `🌍 WORLD UPDATE\n\n${cleanNarration}`
  );
}

/* =====================
   GROUP COMMAND GUARD
===================== */
bot.on("message", ctx => {
  if (
    ctx.chat.type === "group" ||
    ctx.chat.type === "supergroup"
  ) {
    // Ignore all non-command messages in group
    if (!ctx.message.text?.startsWith("/")) return;

    // Ignore commands from other groups
    if (String(ctx.chat.id) !== ADMIN_GROUP_ID) return;
  }
});

/* =====================
   WEBHOOK
===================== */
app.post("/webhook", (req, res) => {
  bot.handleUpdate(req.body);
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log("CYOA bot running (group-locked, DM-driven)");
});
