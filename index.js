import express from "express";
import { Telegraf, Markup } from "telegraf";
import axios from "axios";
import admin from "firebase-admin";

/* =====================
   ENV
===================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ADMIN_GROUP_ID = Number(process.env.ADMIN_GROUP_ID);
const PORT = process.env.PORT || 3000;

/* =====================
   FIREBASE
===================== */
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  )
});

const db = admin.firestore();
const WORLD_REF = db.collection("world").doc("main");

/* =====================
   BOT
===================== */
const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

/* =====================
   HELPERS
===================== */
function splitMessage(text, limit = 3800) {
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    if ((current + line).length > limit) {
      chunks.push(current);
      current = "";
    }
    current += line + "\n";
  }
  if (current) chunks.push(current);
  return chunks;
}

async function callGroq(system, user) {
  const res = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: "llama-3.3-70b-versatile",
      temperature: 0.7,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    },
    { headers: { Authorization: `Bearer ${GROQ_API_KEY}` } }
  );
  return res.data.choices[0].message.content;
}

/* =====================
   /INIT (GROUP)
===================== */
bot.command("init", async (ctx) => {
  if (ctx.chat.id !== ADMIN_GROUP_ID) return;

  const snap = await WORLD_REF.get();
  if (!snap.exists) {
    await WORLD_REF.set({
      status: "INIT",
      setup: { completedSteps: [] },
      players: {},
      rolesTaken: [],
      phase: { number: 0 }
    });
  }

  const world = (await WORLD_REF.get()).data();
  const done = world.setup.completedSteps;

  let next;
  if (!done.includes("world")) next = "WORLD";
  else if (!done.includes("system")) next = "SYSTEM";
  else if (!done.includes("roles")) next = "ROLES";
  else {
    await ctx.reply("✅ World already initialized. Waiting for players.");
    return;
  }

  await ctx.reply(
    `🛠 Setup step: *${next}*\nSend prompt messages.\nType /done when finished.`,
    { parse_mode: "Markdown" }
  );

  ctx.session = { collecting: next, buffer: "" };
});

/* =====================
   PROMPT COLLECTION
===================== */
bot.on("text", async (ctx) => {
  if (!ctx.session?.collecting) return;

  if (ctx.message.text === "/done") {
    const step = ctx.session.collecting.toLowerCase();
    await WORLD_REF.update({
      [`setup.${step}Prompt`]: ctx.session.buffer,
      "setup.completedSteps": admin.firestore.FieldValue.arrayUnion(step)
    });

    ctx.session = null;

    await ctx.reply(`✅ ${step} prompt saved.`);
    return;
  }

  ctx.session.buffer += ctx.message.text + "\n";
});

/* =====================
   /START (DM)
===================== */
bot.start(async (ctx) => {
  if (ctx.chat.type !== "private") return;

  await ctx.reply("Enter your character name:");
  ctx.session = { state: "NAME" };
});

bot.on("text", async (ctx) => {
  if (ctx.chat.type !== "private") return;

  const world = (await WORLD_REF.get()).data();
  const players = world.players || {};

  if (ctx.session?.state === "NAME") {
    const name = ctx.message.text.trim();

    if (Object.values(players).some(p => p.characterName === name)) {
      await ctx.reply("❌ Name already taken. Choose another.");
      return;
    }

    players[ctx.from.id] = {
      tgName: ctx.from.username || ctx.from.first_name,
      characterName: name,
      ready: false
    };

    await WORLD_REF.update({ players });

    await bot.telegram.sendMessage(
      ADMIN_GROUP_ID,
      `🧍 ${ctx.from.first_name} → *${name}*`,
      { parse_mode: "Markdown" }
    );

    ctx.session = { state: "ROLE" };
    await ctx.reply("✅ Name registered. Role selection coming soon.");
  }
});

/* =====================
   SERVER
===================== */
app.get("/", (_, res) => res.send("Bot running"));
bot.launch();
app.listen(PORT);
