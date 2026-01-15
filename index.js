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

  const snapshot = await db.collection("worlds").get();

  if (snapshot.empty) {
    return ctx.reply(
      "🌍 No worlds exist yet.",
      Markup.inlineKeyboard([
        Markup.button.callback("➕ Create New World", "CREATE_WORLD")
      ])
    );
  }

  const buttons = snapshot.docs.map(doc =>
    Markup.button.callback(doc.id, `LOAD_${doc.id}`)
  );

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
  console.log("🔥 CREATE_WORLD clicked");
  await ctx.answerCbQuery();

  if (!ctx.chat || ctx.chat.type === "private") {
    return ctx.reply("❌ World creation must be done in the group.");
  }

  const groupId = String(ctx.chat.id);
  const adminId = String(ctx.from.id);

  await db.collection("sessions").doc(groupId).set({
    step: "WORLD_PROMPT",
    adminId,
    createdAt: Date.now()
  });

  await ctx.telegram.sendMessage(
    groupId,
    "🌏 **WORLD BUILDING PROMPT**\n\nSend the lore, history, factions, and power systems.",
    { parse_mode: "Markdown" }
  );
});


/* =====================
   WORLD PROMPT HANDLING (DM)
===================== */
bot.on("text", async ctx => {
  // ONLY group messages
  if (ctx.chat.type === "private") return;

  const groupId = String(ctx.chat.id);
  const sessionRef = db.collection("sessions").doc(groupId);
  const sessionSnap = await sessionRef.get();

  if (!sessionSnap.exists) return;

  const session = sessionSnap.data();

  // Only admin can continue setup
  if (String(ctx.from.id) !== session.adminId) {
    return ctx.reply("⛔ Only the world creator may define this.");
  }

  /* =====================
     WORLD PROMPT
  ===================== */
  if (session.step === "WORLD_PROMPT") {
    await sessionRef.update({
      worldPrompt: ctx.message.text,
      step: "SYSTEM_PROMPT"
    });

    return ctx.reply(
      "🧠 **SYSTEM PROMPT**\n\n" +
      "Define rules, god behavior, fairness, narrative limits.",
      { parse_mode: "Markdown" }
    );
  }

  /* =====================
     SYSTEM PROMPT → CREATE WORLD
  ===================== */
  if (session.step === "SYSTEM_PROMPT") {
    const worldId = `world_${Date.now()}`;

    await db.collection("worlds").doc(worldId).set({
      meta: {
        id: worldId,
        groupId,
        phase: 1,
        round: 0,
        currentTurn: "",
        worldState: "",
        maxPlayers: 1,
        createdAt: Date.now()
      },
      prompts: {
        worldPrompt: session.worldPrompt,
        systemPrompt: ctx.message.text
      }
    });

    await db.collection("groups").doc(groupId).set({
      activeWorldId: worldId,
      updatedAt: Date.now()
    });

    await sessionRef.delete();

    return ctx.reply(
      `✅ **World Created Successfully**\n\n` +
      `🌍 ID: \`${worldId}\`\n` +
      `📌 Bound to this group\n\n` +
      `Players may now DM /start`,
      { parse_mode: "Markdown" }
    );
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