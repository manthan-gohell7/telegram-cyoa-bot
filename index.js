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

  // 🔍 Find which group this user belongs to
  // (For now we assume ONE group → later we can extend)
  const groupSnap = await db.collection("groups").get();

  if (groupSnap.empty) {
    return ctx.reply("🌫️ No world is currently active.");
  }

  // Take the first active group (current design)
  const groupDoc = groupSnap.docs[0];
  const groupId = groupDoc.id;
  const activeWorldId = groupDoc.data().activeWorldId;

  if (!activeWorldId) {
    return ctx.reply("🌫️ No world is currently active.");
  }

  const worldRef = db.collection("worlds").doc(activeWorldId);
  const worldSnap = await worldRef.get();

  if (!worldSnap.exists) {
    return ctx.reply("❌ The active world no longer exists.");
  }

  const playerRef = worldRef.collection("players").doc(userId);
  const playerSnap = await playerRef.get();

  /* =====================
     PLAYER EXISTS → RESUME
  ===================== */
  if (playerSnap.exists) {
    const player = playerSnap.data();

    await playerRef.update({
      lastActive: Date.now()
    });

    return ctx.reply(
      `🧭 Welcome back, ${player.character.name}.\n\n` +
      `🌍 World: ${worldSnap.data().meta.name}\n` +
      `📜 Your journey continues…`,
      { parse_mode: "Markdown" }
    );
  }

  /* =====================
     NEW PLAYER → ASK NAME
  ===================== */
  await db.collection("sessions").doc(`player_${userId}`).set({
    step: "CHARACTER_NAME",
    worldId: activeWorldId,
    userId,
    createdAt: Date.now()
  });

  return ctx.reply(
    "✨ A new soul approaches this world.\n\n" +
    "What is your character name?"
  );
});

/* =====================
   /groupid (DEBUG)
===================== */
bot.command("groupid", ctx => {
  ctx.reply(`Group ID: ${ctx.chat.id}`);
});

/* =====================
   /help
===================== */
bot.command("help", ctx => {
  ctx.reply(`
🎮 ASTRA MARE — CYOA BOT

👥 GROUP COMMANDS
/init   → Select or create a world
/help   → Show help

🧍 PLAYER (DM)
/start  → Register character
A/B/C   → Choose an action when prompted

📜 RULES
- Group = world narration
- DM = personal choices
- Choices must begin with A, B, or C
`);
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
      "🌍 No worlds exist yet.",
      Markup.inlineKeyboard([
        Markup.button.callback("➕ Create New World", "CREATE_WORLD")
      ])
    );
  }

  const buttons = snapshot.docs.map(doc => {
    const data = doc.data();
    return Markup.button.callback(
      `🌍 ${data.meta.name}`,
      `LOAD_${doc.id}`
    );
  });

  buttons.push(Markup.button.callback("➕ Create New World", "CREATE_WORLD"));

  await ctx.reply(
    "🌍 Select a world:",
    Markup.inlineKeyboard(buttons.map(b => [b]))
  );
});

/* =====================
   CREATE WORLD FLOW
===================== */
bot.action("CREATE_WORLD", async ctx => {
  await ctx.answerCbQuery();

  if (!ctx.chat || ctx.chat.type === "private") {
    return ctx.reply("❌ World creation must be done in the group.");
  }

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
    "🌍 WORLD NAME\n\nSend the name of this world.",
    { parse_mode: "Markdown" }
  );
});

/* =====================
   LOAD EXISTING WORLD
===================== */
bot.action(/^LOAD_(.+)/, async ctx => {
  await ctx.answerCbQuery();

  if (String(ctx.chat.id) !== String(ADMIN_GROUP_ID)) return;

  const worldId = ctx.match[1];
  const worldSnap = await db.collection("worlds").doc(worldId).get();

  if (!worldSnap.exists) {
    return ctx.reply("❌ This world no longer exists.");
  }

  await db.collection("groups").doc(String(ctx.chat.id)).set({
    activeWorldId: worldId,
    updatedAt: Date.now()
  });

  const world = worldSnap.data();

  await ctx.reply(
    `🌍 World Loaded\n\n` +
    `Name: ${world.meta.name}\n` +
    `Players may now DM /start`,
    { parse_mode: "Markdown" }
  );
});

/* =====================
   WORLD PROMPT HANDLING (DM)
===================== */
bot.on("text", async ctx => {
  // GROUP ONLY
  if (ctx.chat.type === "private") return;

  const groupId = String(ctx.chat.id);
  const sessionRef = db.collection("sessions").doc(groupId);
  const snap = await sessionRef.get();

  if (!snap.exists) return;

  const session = snap.data();

  // ONLY ADMIN CAN DEFINE WORLD
  if (String(ctx.from.id) !== session.adminId) {
    return ctx.reply("⛔ Only the world creator may define this.");
  }

  const text = ctx.message.text.trim();
  const key = `${groupId}_${session.step}`;

  /* =====================
   WORLD NAME (UNIQUE)
===================== */
  if (session.step === "WORLD_NAME") {
    const worldName = text.replace(/\s+/g, " ").trim();

    if (worldName.length < 3 || worldName.length > 40) {
      return ctx.reply("❌ World name must be 3–40 characters long.");
    }

    // 🔍 Check uniqueness (case-insensitive)
    const existing = await db
      .collection("worlds")
      .where("meta.name_lower", "==", worldName.toLowerCase())
      .limit(1)
      .get();

    if (!existing.empty) {
      return ctx.reply(
        "⚠️ A world with this name already exists.\n\n" +
        "Please choose a different name."
      );
    }

    await sessionRef.update({
      worldName,
      worldNameLower: worldName.toLowerCase(),
      buffer: [],               // 🔑 reset buffer
      step: "WORLD_PROMPT"
    });


    return ctx.reply(
      "🌏 WORLD BUILDING PROMPT\n\n" +
      "Send the lore, history, factions, and power systems.\n" +
      "You may send multiple messages.",
      { parse_mode: "Markdown" }
    );
  }


  /* =====================
     WORLD PROMPT (MULTI)
  ===================== */
  if (session.step === "WORLD_PROMPT") {
    // FINALIZE WORLD PROMPT
    if (text.toLowerCase() === "/done") {

      if (!session.buffer.length) {
        return ctx.reply("⚠️ Prompt cannot be empty.");
      }


      // Cancel pending debounce reply
      if (ackTimers.has(key)) {
        clearTimeout(ackTimers.get(key));
        ackTimers.delete(key);
      }

      const fullWorldPrompt = session.buffer
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      await sessionRef.update({
        worldPrompt: fullWorldPrompt,
        buffer: [],
        step: "SYSTEM_PROMPT"
      });

      return ctx.reply(
        "🧠 SYSTEM PROMPT\n\n" +
        "Send the system prompt in one or more messages.\n" +
        { parse_mode: "Markdown" }
      );
    }

    // BUFFER INPUT
    await sessionRef.update({
      buffer: admin.firestore.FieldValue.arrayUnion(text)
    });

    // DEBOUNCED ACK
    if (ackTimers.has(key)) {
      clearTimeout(ackTimers.get(key));
    }

    ackTimers.set(
      key,
      setTimeout(async () => {
        await ctx.reply("📥 Added. Continue or send /done when finished.");
        ackTimers.delete(key);
      }, 1000)
    );

    return;
  }

  /* =====================
     SYSTEM PROMPT (MULTI)
  ===================== */
  if (session.step === "SYSTEM_PROMPT") {
    if (!session.worldPrompt) {
      return ctx.reply("⚠️ World prompt missing. Restart with /init.");
    }


    // FINALIZE SYSTEM PROMPT
    if (text.toLowerCase() === "/done") {
      if (!session.buffer.length) {
        return ctx.reply("⚠️ Prompt cannot be empty.");
      }

      // Cancel pending debounce reply
      if (ackTimers.has(key)) {
        clearTimeout(ackTimers.get(key));
        ackTimers.delete(key);
      }

      const fullSystemPrompt = session.buffer
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      const worldId = `world_${Date.now()}`;

      await db.collection("worlds").doc(worldId).set({
        meta: {
          id: worldId,
          name: session.worldName,
          name_lower: session.worldNameLower, // 🔑 REQUIRED
          groupId,
          createdBy: session.adminId,
          phase: 1,
          round: 0,
          currentTurn: "",
          worldState: "",
          maxPlayers: 1,
          createdAt: Date.now()
        },
        prompts: {
          worldPrompt: session.worldPrompt,
          systemPrompt: fullSystemPrompt
        }
      });


      await db.collection("groups").doc(groupId).set({
        activeWorldId: worldId,
        updatedAt: Date.now()
      });

      await sessionRef.delete();

      return ctx.reply(
        `✅ World Created Successfully\n\n` +
        `🌍 Name: \`${session.worldName}\`\n` +
        `📌 Currently active in this group\n\n` +
        `Players may now DM /start`,
        { parse_mode: "Markdown" }
      );
    }

    // BUFFER INPUT
    await sessionRef.update({
      buffer: admin.firestore.FieldValue.arrayUnion(text)
    });

    // DEBOUNCED ACK
    if (ackTimers.has(key)) {
      clearTimeout(ackTimers.get(key));
    }

    ackTimers.set(
      key,
      setTimeout(async () => {
        await ctx.reply("📥 Added. Continue or send /done when finished.");
        ackTimers.delete(key);
      }, 1000)
    );

    return;
  }
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
  console.log("🔥 Astra Mare CYOA bot running (Firestore + Groq)");
});