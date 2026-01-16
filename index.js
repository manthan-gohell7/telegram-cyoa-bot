import express from "express";
import { Telegraf, Markup } from "telegraf";
import axios from "axios";
import admin from "firebase-admin";

/* =====================
   ENV
===================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ADMIN_GROUP_ID = process.env.ADMIN_GROUP_ID;
const PORT = process.env.PORT || 3000;

const ackTimers = new Map();

/* =====================
   FIREBASE INIT
===================== */
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  )
});

const db = admin.firestore();

/* =====================
   TELEGRAM
===================== */
const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

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

/* =====================
   /start — PLAYER REGISTER / RESUME (DM)
===================== */
bot.start(async ctx => {
  if (ctx.chat.type !== "private") return;

  const userId = String(ctx.from.id);

  const groupSnap = await db.collection("groups").get();
  if (groupSnap.empty) {
    return ctx.reply("No world is currently active.");
  }

  const groupDoc = groupSnap.docs[0];
  const activeWorldId = groupDoc.data().activeWorldId;

  if (!activeWorldId) {
    return ctx.reply("No world is currently active.");
  }

  const worldRef = db.collection("worlds").doc(activeWorldId);
  const worldSnap = await worldRef.get();

  if (!worldSnap.exists) {
    return ctx.reply("The active world no longer exists.");
  }

  const playerRef = worldRef.collection("players").doc(userId);
  const playerSnap = await playerRef.get();

  if (playerSnap.exists) {
    await playerRef.update({ lastActive: Date.now() });
    return ctx.reply(
      `Welcome back, ${playerSnap.data().character.name}\nWorld: ${worldSnap.data().meta.name}`
    );
  }

  await db.collection("sessions").doc(`player_${userId}`).set({
    step: "CHARACTER_NAME",
    worldId: activeWorldId,
    userId,
    createdAt: Date.now()
  });

  return ctx.reply("A new soul approaches.\nWhat is your character name?");
});

/* =====================
   /groupid
===================== */
bot.command("groupid", ctx => {
  ctx.reply(String(ctx.chat.id));
});

/* =====================
   /init — WORLD SELECT
===================== */
bot.command("init", async ctx => {
  if (String(ctx.chat.id) !== String(ADMIN_GROUP_ID)) return;

  const snapshot = await db
    .collection("worlds")
    .where("meta.groupId", "==", String(ctx.chat.id))
    .get();

  if (snapshot.empty) {
    return ctx.reply(
      "No worlds exist yet.",
      Markup.inlineKeyboard([
        Markup.button.callback("Create New World", "CREATE_WORLD")
      ])
    );
  }

  const buttons = snapshot.docs.map(doc =>
    Markup.button.callback(doc.data().meta.name, `LOAD_${doc.id}`)
  );

  buttons.push(Markup.button.callback("Create New World", "CREATE_WORLD"));

  await ctx.reply(
    "Select a world:",
    Markup.inlineKeyboard(buttons.map(b => [b]))
  );
});

/* =====================
   CREATE WORLD
===================== */
bot.action("CREATE_WORLD", async ctx => {
  await ctx.answerCbQuery();

  const groupId = String(ctx.chat.id);
  const adminId = String(ctx.from.id);

  await db.collection("sessions").doc(groupId).set({
    step: "WORLD_NAME",
    adminId,
    buffer: [],
    createdAt: Date.now()
  });

  await ctx.telegram.sendMessage(
    groupId,
    "Send the world name."
  );
});

/* =====================
   LOAD WORLD
===================== */
bot.action(/^LOAD_(.+)/, async ctx => {
  await ctx.answerCbQuery();

  const worldId = ctx.match[1];
  await db.collection("groups").doc(String(ctx.chat.id)).set({
    activeWorldId: worldId,
    updatedAt: Date.now()
  });

  const world = (await db.collection("worlds").doc(worldId).get()).data();

  await ctx.reply(
    `World loaded: ${world.meta.name}\nPlayers may DM /start`
  );
});

/* =====================
   ROLE GENERATION
===================== */
async function generateRolesFromWorldPrompt(worldId) {
  const worldRef = db.collection("worlds").doc(worldId);
  const world = (await worldRef.get()).data();

  const response = await callGroq(
    "You are a game system designer.",
    `
World Prompt:
${world.prompts.worldPrompt}

Extract playable roles only.
Return JSON:
[{ "id": "string", "name": "string", "description": "string" }]
`
  );

  const roles = JSON.parse(response);
  if (roles.length !== world.meta.maxPlayers) {
    throw new Error("Role count mismatch");
  }

  for (const role of roles) {
    await worldRef.collection("roles").doc(role.id).set({
      ...role,
      assignedTo: null,
      createdAt: Date.now()
    });
  }

  await worldRef.update({ "meta.phase": "ROLE_SELECTION" });
}

/* =====================
   ANNOUNCE ROLE SELECTION
===================== */
async function announceRoleSelection(worldId, groupId) {
  const rolesSnap = await db
    .collection("worlds")
    .doc(worldId)
    .collection("roles")
    .get();

  const buttons = rolesSnap.docs.map(doc =>
    Markup.button.callback(doc.data().name, `ROLE_${doc.id}`)
  );

  await bot.telegram.sendMessage(
    groupId,
    "Role selection phase. Choose one role.",
    Markup.inlineKeyboard(buttons.map(b => [b]))
  );
}

/* =====================
   ROLE PICK
===================== */
bot.action(/^ROLE_(.+)/, async ctx => {
  await ctx.answerCbQuery();

  const roleId = ctx.match[1];
  const userId = String(ctx.from.id);
  const groupId = String(ctx.chat.id);

  const worldId = (await db.collection("groups").doc(groupId).get()).data().activeWorldId;
  const worldRef = db.collection("worlds").doc(worldId);

  const roleRef = worldRef.collection("roles").doc(roleId);
  const role = (await roleRef.get()).data();

  if (role.assignedTo) return ctx.reply("Role already taken.");

  await roleRef.update({ assignedTo: userId });
  await worldRef.collection("players").doc(userId).update({
    "character.role": { id: roleId, name: role.name }
  });

  await ctx.telegram.sendMessage(
    groupId,
    `Role locked: ${role.name}`
  );
});

/* =====================
   DM CHARACTER NAME HANDLER
===================== */
bot.on("text", async ctx => {
  if (ctx.chat.type !== "private") return;

  const userId = String(ctx.from.id);
  const text = ctx.message.text.trim();

  const sessionRef = db.collection("sessions").doc(`player_${userId}`);
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) return;

  const session = sessionSnap.data();
  if (session.step !== "CHARACTER_NAME") return;

  const worldRef = db.collection("worlds").doc(session.worldId);
  const world = (await worldRef.get()).data();

  await worldRef.collection("players").doc(userId).set({
    userId,
    character: { name: text },
    stats: {
      skillEssence: { current: 100, max: 100, regenPerTurn: 20 }
    },
    createdAt: Date.now()
  });

  const playersCount = (await worldRef.collection("players").get()).size;

  await bot.telegram.sendMessage(
    world.meta.groupId,
    `Player joined: ${text} (${playersCount}/${world.meta.maxPlayers})`
  );

  if (playersCount === world.meta.maxPlayers && world.meta.phase !== "ROLE_SELECTION") {
    await generateRolesFromWorldPrompt(session.worldId);
    await announceRoleSelection(session.worldId, world.meta.groupId);
  }

  await sessionRef.delete();
  return ctx.reply(`Welcome, ${text}`);
});

/* =====================
   WEBHOOK
===================== */
app.post("/webhook", (req, res) => {
  bot.handleUpdate(req.body);
  res.sendStatus(200);
});

/* =====================
   SERVER
===================== */
app.listen(PORT, () => {
  console.log("Bot running");
});
