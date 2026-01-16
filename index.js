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
   /start — PLAYER REGISTER (DM)
===================== */
bot.start(async ctx => {
  if (ctx.chat.type !== "private") return;

  const userId = String(ctx.from.id);
  const groupSnap = await db.collection("groups").get();
  if (groupSnap.empty) return ctx.reply("No world is currently active.");

  const activeWorldId = groupSnap.docs[0].data().activeWorldId;
  if (!activeWorldId) return ctx.reply("No world is currently active.");

  const worldRef = db.collection("worlds").doc(activeWorldId);
  const worldSnap = await worldRef.get();
  if (!worldSnap.exists) return ctx.reply("World no longer exists.");

  const playerRef = worldRef.collection("players").doc(userId);
  const playerSnap = await playerRef.get();

  if (playerSnap.exists) {
    return ctx.reply(
      `Welcome back, ${playerSnap.data().character.name}\nWorld: ${worldSnap.data().meta.name}`
    );
  }

  await db.collection("sessions").doc(`player_${userId}`).set({
    step: "CHARACTER_NAME",
    worldId: activeWorldId,
    createdAt: Date.now()
  });

  ctx.reply("A new soul approaches.\nWhat is your character name?");
});

/* =====================
   /groupid
===================== */
bot.command("groupid", ctx => ctx.reply(String(ctx.chat.id)));

/* =====================
   /init — WORLD SELECT
===================== */
bot.command("init", async ctx => {
  if (String(ctx.chat.id) !== String(ADMIN_GROUP_ID)) return;

  const snap = await db
    .collection("worlds")
    .where("meta.groupId", "==", String(ctx.chat.id))
    .get();

  if (snap.empty) {
    return ctx.reply(
      "No worlds exist.",
      Markup.inlineKeyboard([
        Markup.button.callback("Create New World", "CREATE_WORLD")
      ])
    );
  }

  const buttons = snap.docs.map(d =>
    Markup.button.callback(d.data().meta.name, `LOAD_${d.id}`)
  );
  buttons.push(Markup.button.callback("Create New World", "CREATE_WORLD"));

  ctx.reply("Select a world:", Markup.inlineKeyboard(buttons.map(b => [b])));
});

/* =====================
   CREATE WORLD
===================== */
bot.action("CREATE_WORLD", async ctx => {
  await ctx.answerCbQuery();

  await db.collection("sessions").doc(String(ctx.chat.id)).set({
    step: "WORLD_NAME",
    buffer: {},
    createdAt: Date.now()
  });

  ctx.telegram.sendMessage(ctx.chat.id, "Send the world name.");
});

/* =====================
   LOAD WORLD
===================== */
bot.action(/^LOAD_(.+)/, async ctx => {
  await ctx.answerCbQuery();

  await db.collection("groups").doc(String(ctx.chat.id)).set({
    activeWorldId: ctx.match[1],
    updatedAt: Date.now()
  });

  const world = (await db.collection("worlds").doc(ctx.match[1]).get()).data();
  ctx.reply(`World loaded: ${world.meta.name}\nPlayers may DM /start`);
});

/* =====================
   GROUP TEXT HANDLER (WORLD CREATION)
===================== */
bot.on("text", async ctx => {
  if (ctx.chat.type === "private") return;

  const groupId = String(ctx.chat.id);
  const sessionRef = db.collection("sessions").doc(groupId);
  const snap = await sessionRef.get();
  if (!snap.exists) return;

  const session = snap.data();
  const text = ctx.message.text.trim();

  /* WORLD NAME */
  if (session.step === "WORLD_NAME") {
    session.buffer.name = text;
    session.step = "WORLD_PROMPT";
    await sessionRef.set(session);
    return ctx.reply("Send the WORLD PROMPT (lore, rules, setting).");
  }

  /* WORLD PROMPT */
  if (session.step === "WORLD_PROMPT") {
    session.buffer.worldPrompt = text;
    session.step = "SYSTEM_PROMPT";
    await sessionRef.set(session);
    return ctx.reply("Send the SYSTEM PROMPT (rules for the AI narrator).");
  }

  /* SYSTEM PROMPT → FINALIZE */
  if (session.step === "SYSTEM_PROMPT") {
    const worldRef = await db.collection("worlds").add({
      meta: {
        name: session.buffer.name,
        groupId,
        maxPlayers: 1, // TESTING
        phase: "PLAYER_JOIN"
      },
      prompts: {
        worldPrompt: session.buffer.worldPrompt,
        systemPrompt: text
      },
      createdAt: Date.now()
    });

    await db.collection("groups").doc(groupId).set({
      activeWorldId: worldRef.id
    });

    await sessionRef.delete();
    return ctx.reply(`World created: ${session.buffer.name}\nPlayers may DM /start`);
  }
});

/* =====================
   ROLE GENERATION
===================== */
async function generateRolesFromWorldPrompt(worldId) {
  const worldRef = db.collection("worlds").doc(worldId);
  const world = (await worldRef.get()).data();

  const raw = await callGroq(
    "You are a game system designer.",
    `
World Prompt:
${world.prompts.worldPrompt}

Return STRICT JSON array:
[{ "id": "string", "name": "string", "description": "string" }]
`
  );

  let roles;
  try {
    roles = JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON from Groq");
  }

  for (const r of roles) {
    await worldRef.collection("roles").doc(r.id).set({
      ...r,
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
  const snap = await db.collection("worlds").doc(worldId).collection("roles").get();
  const buttons = snap.docs.map(d =>
    Markup.button.callback(d.data().name, `ROLE_${d.id}`)
  );

  bot.telegram.sendMessage(
    groupId,
    "Role selection phase.",
    Markup.inlineKeyboard(buttons.map(b => [b]))
  );
}

/* =====================
   ROLE PICK
===================== */
bot.action(/^ROLE_(.+)/, async ctx => {
  await ctx.answerCbQuery();

  const groupId = String(ctx.chat.id);
  const userId = String(ctx.from.id);
  const worldId = (await db.collection("groups").doc(groupId).get()).data().activeWorldId;

  const roleRef = db.collection("worlds").doc(worldId).collection("roles").doc(ctx.match[1]);
  const role = (await roleRef.get()).data();

  if (role.assignedTo) return ctx.reply("Role already taken.");

  await roleRef.update({ assignedTo: userId });
  await db.collection("worlds").doc(worldId).collection("players").doc(userId).update({
    "character.role": { id: ctx.match[1], name: role.name }
  });

  ctx.reply(`Role locked: ${role.name}`);
});

/* =====================
   PLAYER NAME HANDLER (DM)
===================== */
bot.on("text", async ctx => {
  if (ctx.chat.type !== "private") return;

  const userId = String(ctx.from.id);
  const text = ctx.message.text.trim();

  const sessionRef = db.collection("sessions").doc(`player_${userId}`);
  const snap = await sessionRef.get();
  if (!snap.exists || snap.data().step !== "CHARACTER_NAME") return;

  const worldRef = db.collection("worlds").doc(snap.data().worldId);
  const world = (await worldRef.get()).data();

  await worldRef.collection("players").doc(userId).set({
    character: { name: text },
    createdAt: Date.now()
  });

  const count = (await worldRef.collection("players").get()).size;

  if (count === world.meta.maxPlayers && world.meta.phase !== "ROLE_SELECTION") {
    await generateRolesFromWorldPrompt(snap.data().worldId);
    await announceRoleSelection(snap.data().worldId, world.meta.groupId);
  }

  await sessionRef.delete();
  ctx.reply(`Welcome, ${text}`);
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
app.listen(PORT, () => console.log("Bot running"));