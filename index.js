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
   /INIT – GROUP
===================== */
bot.command("init", async (ctx) => {
  if (ctx.chat.id !== ADMIN_GROUP_ID) return;

  const snap = await WORLD_REF.get();
  if (snap.exists) {
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
    "✏️ Please manually populate the following fields in Firestore:\n" +
    "• setup.worldPrompt\n" +
    "• setup.systemPrompt\n" +
    "• setup.rolePrompt\n\n" +
    "📢 Send /done when ready."
  );
});

/* =====================
   /DONE – READ ROLES
===================== */
bot.command("done", async (ctx) => {
  if (ctx.chat.id !== ADMIN_GROUP_ID) return;

  const snap = await WORLD_REF.get();
  if (!snap.exists) {
    await ctx.reply("❌ World not initialized. Use /init first.");
    return;
  }

  const world = snap.data();
  const rolePrompt = world.setup.rolePrompt;

  if (!rolePrompt || rolePrompt.trim() === "") {
    await ctx.reply("❌ rolePrompt is empty in Firestore.");
    return;
  }

  // Extract roles: "1. THE HUNTER (HUMAN)"
  const roles = rolePrompt
    .split("\n")
    .map(line => line.trim())
    .filter(line => /^\d+\.\s/.test(line))
    .map(line =>
      line
        .replace(/^\d+\.\s*/, "")
        .split("(")[0]
        .trim()
    );

  if (roles.length === 0) {
    await ctx.reply("❌ No roles detected. Check rolePrompt format.");
    return;
  }

  await WORLD_REF.update({
    roles,
    status: "WAITING_PLAYERS"
  });

  let msg = "🎭 *AVAILABLE ROLES*\n\n";
  roles.forEach((r, i) => {
    msg += `${i + 1}. ${r}\n`;
  });

  msg += "\n📩 Players can now DM `/start` to join.";

  await ctx.reply(msg, { parse_mode: "Markdown" });
});

/* =====================
   /START – PLAYER DM
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
    await ctx.reply("⏳ Game not ready yet.");
    return;
  }

  await ctx.reply("📝 Enter your character name:");
  ctx.state.awaitingName = true;
});

/* =====================
   PLAYER NAME INPUT
===================== */
bot.on("text", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  if (!ctx.state.awaitingName) return;

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

  await bot.telegram.sendMessage(
    ADMIN_GROUP_ID,
    `🧍 ${ctx.from.first_name} → *${name}*`,
    { parse_mode: "Markdown" }
  );

  ctx.state.awaitingName = false;
  await ctx.reply("✅ Name registered.\nRole selection will begin soon.");
});

/* =====================
   SERVER
===================== */
app.get("/", (_, res) => res.send("Bot running"));
bot.launch();
app.listen(PORT);