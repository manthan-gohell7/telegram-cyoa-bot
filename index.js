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

const MAX_PLAYERS = 1; // testing

async function checkAndStartRoleSelection(bot) {
  const snap = await WORLD_REF.get();
  if (!snap.exists) return;

  const world = snap.data();
  const players = world.players || {};
  const joinedCount = Object.keys(players).length;

  if (
    world.status === "WAITING_PLAYERS" &&
    joinedCount === MAX_PLAYERS
  ) {
    await WORLD_REF.update({ status: "ROLE_SELECTION" });

    // Group announcement (already exists)
    let msg = "🎭 *ROLE SELECTION*\n\n";
    world.roles.forEach((r, i) => {
      msg += `${i + 1}. ${r}\n`;
    });
    msg += "\n📩 Select your role in DM.";

    await bot.telegram.sendMessage(
      ADMIN_GROUP_ID,
      msg,
      { parse_mode: "Markdown" }
    );

    // 🔥 NEW: DM each player
    for (const playerId of Object.keys(players)) {
      await bot.telegram.sendMessage(
        playerId,
        "🎭 *Choose your role*",
        {
          parse_mode: "Markdown",
          reply_markup: buildRoleKeyboard(
            world.roles,
            world.rolesTaken || []
          )
        }
      );
    }
  }
}

/* =====================
   /INIT – ONE TIME
===================== */
bot.command("init", async (ctx) => {
  if (ctx.chat.id !== ADMIN_GROUP_ID) return;

  const snap = await WORLD_REF.get();

  // World does not exist → create it
  if (!snap.exists) {
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
    return;
  }

  // World exists → resume based on state
  const world = snap.data();

  switch (world.status) {
    case "SETUP":
      await ctx.reply(
        "⚠️ World already initialized.\n\n" +
        "✏️ Populate prompts in Firestore.\n" +
        "📢 Use /done when ready."
      );
      break;

    case "WAITING_PLAYERS": {
      const players = Object.values(world.players || {});
      const joined = players.length;
      const remaining = MAX_PLAYERS - joined;

      const list = joined
        ? players.map(p => `• ${p.characterName}`).join("\n")
        : "_No players yet_";

      await ctx.reply(
        "🕰 *World is ready.*\n\n" +
        "👥 Registered players:\n" +
        list + "\n\n" +
        `📊 Players joined: ${joined} / ${MAX_PLAYERS}\n` +
        `⏳ Remaining slots: ${remaining}`,
        { parse_mode: "Markdown" }
      );

      // 🔥 THIS WAS MISSING
      await checkAndStartRoleSelection(bot);
      break;
    }


    case "ROLE_SELECTION":
      await ctx.reply(
        "🎭 Role selection has already started."
      );
      break;

    case "RUNNING":
      await ctx.reply(
        "⚔️ Game is already in progress."
      );
      break;

    default:
      await ctx.reply("❌ Unknown world state.");
  }
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

function buildRoleKeyboard(roles, rolesTaken) {
  const available = roles.filter(r => !rolesTaken.includes(r));

  return {
    inline_keyboard: available.map(role => [
      { text: role, callback_data: `ROLE_PICK:${role}` }
    ])
  };
}

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
  const players = world.players || {};
  const playerId = String(ctx.from.id);

  /* =====================
     CASE 1: PLAYER ALREADY REGISTERED
  ===================== */
  if (players[playerId]) {
    await ctx.reply(
      "✅ You are already registered.\n" +
      "Resuming game state..."
    );

    // 🔥 Re-evaluate world progression
    await checkAndStartRoleSelection(bot);
    return;
  }


  /* =====================
     CASE 2: NEW PLAYER, CHECK LIMIT
  ===================== */
  if (Object.keys(players).length >= MAX_PLAYERS) {
    const registeredList = Object.values(players)
      .map(p => `• ${p.characterName}`)
      .join("\n");

    await ctx.reply(
      "🚫 *Player limit reached.*\n\n" +
      "Registered players:\n" +
      registeredList,
      { parse_mode: "Markdown" }
    );
    return;
  }

  /* =====================
     CASE 3: ACCEPT NEW PLAYER
  ===================== */
  if (world.status !== "WAITING_PLAYERS") {
    await ctx.reply("⏳ Player registration closed.");
    return;
  }

  awaitingName.add(ctx.from.id);

  await ctx.reply(
    "🌍 *Welcome to the world.*\n\n" +
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

  const joinedCount = Object.keys(players).length;

  /* GROUP ANNOUNCEMENT WITH COUNT */
  await bot.telegram.sendMessage(
    ADMIN_GROUP_ID,
    `🧍 ${ctx.from.first_name} → *${name}*\n` +
    `👥 Players joined: ${joinedCount} / ${MAX_PLAYERS}`,
    { parse_mode: "Markdown" }
  );

  /* PERSONAL CONFIRMATION */
  await ctx.reply(
    "✅ Character registered.\n\n" +
    "Please wait for other players."
  );

  /* ALL PLAYERS JOINED → SHOW ROLES */
  if (joinedCount === MAX_PLAYERS) {
    await WORLD_REF.update({ status: "ROLE_SELECTION" });

    let msg = "🎭 *ROLE SELECTION*\n\n";
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

bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (!data.startsWith("ROLE_PICK:")) return;

  const chosenRole = data.split(":")[1];
  const playerId = String(ctx.from.id);

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(WORLD_REF);
      const world = snap.data();

      const players = world.players || {};
      const rolesTaken = world.rolesTaken || [];

      // Player validity
      if (!players[playerId]) {
        throw new Error("You are not registered.");
      }

      // Already has a role
      if (players[playerId].role) {
        throw new Error("You already selected a role.");
      }

      // Role already taken
      if (rolesTaken.includes(chosenRole)) {
        throw new Error("Role already taken.");
      }

      // Assign role
      players[playerId].role = chosenRole;
      rolesTaken.push(chosenRole);

      tx.update(WORLD_REF, {
        players,
        rolesTaken
      });
    });

    // Success message
    await ctx.editMessageText(
      `✅ You selected *${chosenRole}*`,
      { parse_mode: "Markdown" }
    );

    // Notify group
    const snap = await WORLD_REF.get();
    const world = snap.data();
    const characterName = world.players[playerId].characterName;

    await bot.telegram.sendMessage(
      ADMIN_GROUP_ID,
      `🎭 *${characterName}* has chosen *${chosenRole}*`,
      { parse_mode: "Markdown" }
    );

  } catch (err) {
    await ctx.answerCbQuery(err.message, { show_alert: true });
  }
});

/* =====================
   SERVER
===================== */
app.get("/", (_, res) => res.send("Bot running"));
bot.launch();
app.listen(PORT);