import express from "express";
import { Telegraf } from "telegraf";
import admin from "firebase-admin";

/* =====================
   ENV
===================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
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
   TEMP STATE (IMPORTANT)
===================== */
const awaitingName = new Set();

/* =====================
   /INIT – ONE TIME
===================== */
bot.command("init", async (ctx) => {
  if (ctx.chat.id !== ADMIN_GROUP_ID) return;

  if ((await WORLD_REF.get()).exists) {
    await ctx.reply("⚠️ World already initialized.");
    return;
  }

  await WORLD_REF.set({
    status: "SETUP",
    setup: {
      worldPrompt: "",
      systemPrompt: "",
      rolePrompt: ""
    },
    roles: [],
    rolesTaken: [],
    players: {}
  });

  await ctx.reply(
    "✅ World initialized.\n\n" +
    "✏️ Populate prompts in Firestore.\n" +
    "📢 Use /done when ready."
  );
});

/* =====================
   /DONE – LOCK WORLD
===================== */
bot.command("done", async (ctx) => {
  if (ctx.chat.id !== ADMIN_GROUP_ID) return;

  const snap = await WORLD_REF.get();
  if (!snap.exists) {
    await ctx.reply("❌ Use /init first.");
    return;
  }

  const world = snap.data();
  const rolePrompt = world.setup.rolePrompt;

  if (!rolePrompt?.trim()) {
    await ctx.reply("❌ rolePrompt is empty.");
    return;
  }

  const roles = rolePrompt
    .split("\n")
    .map(l => l.trim())
    .filter(l => /^\d+\.\s/.test(l))
    .map(l => l.replace(/^\d+\.\s*/, "").split("(")[0].trim());

  if (!roles.length) {
    await ctx.reply("❌ No roles detected.");
    return;
  }

  await WORLD_REF.update({
    roles,
    status: "WAITING_PLAYERS"
  });

  await ctx.reply(
    "🕰 *World is ready.*\n\n" +
    "📩 Players may now DM `/start` to join.",
    { parse_mode: "Markdown" }
  );
});

/* =====================
   /START – PLAYER JOIN
===================== */
bot.start(async (ctx) => {
  if (ctx.chat.type !== "private") return;

  const snap = await WORLD_REF.get();
  if (!snap.exists) {
    await ctx.reply("❌ Game not initialized.");
    return;
  }

  const world = snap.data();
  if (world.status !== "WAITING_PLAYERS") {
    await ctx.reply("⏳ Player registration closed.");
    return;
  }

  awaitingName.add(ctx.from.id);

  await ctx.reply(
    "🌍 *Welcome to the world.*\n\n" +
    "You are about to enter a story shaped by will and consequence.\n\n" +
    "📝 Enter your character name:",
    { parse_mode: "Markdown" }
  );
});

/* =====================
   NAME HANDLER (FIXED)
===================== */
bot.on("text", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  if (!awaitingName.has(ctx.from.id)) return;

  const name = ctx.message.text.trim();
  const snap = await WORLD_REF.get();
  const world = snap.data();
  const players = world.players || {};

  if (Object.values(players).some(p => p.characterName === name)) {
    await ctx.reply("❌ Name already taken. Choose another.");
    return;
  }

  players[ctx.from.id] = {
    tgName: ctx.from.username || ctx.from.first_name,
    characterName: name,
    role: null
  };

  await WORLD_REF.update({ players });
  awaitingName.delete(ctx.from.id);

  /* GROUP ANNOUNCEMENT */
  await bot.telegram.sendMessage(
    ADMIN_GROUP_ID,
    `🧍 ${ctx.from.first_name} → *${name}*`,
    { parse_mode: "Markdown" }
  );

  /* PERSONAL CONFIRMATION */
  await ctx.reply(
    "✅ Character registered.\n\n" +
    "Please wait for other players."
  );

  /* AUTO ROLE SELECTION */
  if (Object.keys(players).length === world.roles.length) {
    await WORLD_REF.update({ status: "ROLE_SELECTION" });

    let msg = "🎭 *ROLE SELECTION BEGINS*\n\n";
    world.roles.forEach((r, i) => {
      msg += `${i + 1}. ${r}\n`;
    });

    msg += "\n📩 Roles will be selected in DM.";

    await bot.telegram.sendMessage(
      ADMIN_GROUP_ID,
      msg,
      { parse_mode: "Markdown" }
    );
  }
});

/* =====================
   SERVER
===================== */
app.get("/", (_, res) => res.send("Bot running"));
bot.launch();
app.listen(PORT);