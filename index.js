import express from "express";
import { Telegraf } from "telegraf";
import admin from "firebase-admin";
import axios from "axios";

/* =====================
   CONFIGURATION
===================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_GROUP_ID = Number(process.env.ADMIN_GROUP_ID);
const PORT = process.env.PORT || 3000;
// const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MAX_PLAYERS = 3; // Adjust as needed
const GOOGLE_API_KEY=process.env.GOOGLE_API_KEY;

/* =====================
   FIREBASE SETUP
===================== */
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  )
});

const db = admin.firestore();
const WORLD_REF = db.collection("world").doc("main");

/* =====================
   BOT INITIALIZATION
===================== */
const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

/* =====================
   IN-MEMORY STATE
===================== */
const awaitingName = new Set();
const awaitingChoice = new Set();

/* =====================
   GROQ API CALL
===================== */
async function callGroq(systemPrompt, userPrompt, temperature = 0.85) {
 /* try {
    const res = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.3-70b-versatile",
        temperature,
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
  } catch (error) {
    console.error("Groq API Error:", error.response?.data || error.message);
    throw new Error("Failed to generate content from AI");
  } */

   try {
    const res = await axios.post(
      "https://generativelanguage.googleapis.com/v1beta/models/gemma-3-27b-it:generateContent",
      {
        contents: [
          {
            role: "user",
            parts: [
              {
                text:
`SYSTEM RULES (MANDATORY):
${systemPrompt}

---
PLAYER INPUT:
${userPrompt}`
              }
            ]
          }
        ],
        generationConfig: {
          temperature,
          topP: 0.95,
          maxOutputTokens: 1024
        }
      },
      {
        params: {
          key: process.env.GOOGLE_API_KEY
        },
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

    const text =
      res.data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      throw new Error("Empty response from Gemma");
    }

    return text;
  } catch (error) {
    console.error(
      "Gemma API Error:",
      error.response?.data || error.message
    );
    throw new Error("Failed to generate content from Gemma");
  }

/* =====================
   PROMPT BUILDERS
===================== */
function buildGroupNarrationPrompt(worldPrompt, worldState, systemPrompt) {
  return `
WORLD LORE:
${worldPrompt}

CURRENT WORLD STATE:
${worldState || "The story is just beginning."}

TASK:
Write a novel-quality third-person world narration that shows the current state of the world and what's happening globally.

CRITICAL RULES:
- Describe ONLY events visible in the shared world
- Do NOT reveal individual player thoughts or private actions
- Do NOT mention player choices directly
- Do NOT reveal hidden information
- Focus on the observable changes in the world
- Tone: dark fantasy, serious, immersive, epic
- Length: 2-4 paragraphs
- Write as if narrating a scene in a novel`;
}

function buildPersonalNarrationPrompt(
  worldPrompt,
  rolePrompt,
  characterName,
  roleName,
  worldState,
  systemPrompt,
  previousChoice = null
) {
  const choiceContext = previousChoice
    ? `\n\nPREVIOUS PLAYER CHOICE:\n${previousChoice}\n\nYou must acknowledge and build upon this choice in the narration.`
    : "";

  return `
WORLD LORE:
${worldPrompt}

CHARACTER ROLES:
${rolePrompt}

CURRENT WORLD STATE:
${worldState || "The story is just beginning."}

CHARACTER:
Name: ${characterName}
Role: ${roleName}
${choiceContext}

TASK:
Write a personal narrative from the perspective of this character. This is their private experience in the world.

CRITICAL RULES:
- Use second-person perspective ("You stand..." or "You feel...") OR close third-person
- Include inner thoughts, feelings, instincts, and private perceptions
- Do NOT describe other players' actions or thoughts
- The narrative must feel personal and immersive
- Show consequences of their previous actions if applicable
- End with EXACTLY THREE meaningful choices

CHOICE FORMAT (MANDATORY):
After the narrative, provide exactly three choices in this format:

A) [First choice - clear and actionable]
B) [Second choice - distinct from A]
C) [Third choice - distinct from A and B]

Each choice must:
- Be concrete and actionable
- Lead to different outcomes
- Fit the character's role and current situation
- Have potential consequences

Tone: Dark fantasy, immersive, novel-quality writing
Length: 3-5 paragraphs + 3 choices`;
}

function buildWorldUpdatePrompt(
  worldPrompt,
  systemPrompt,
  currentWorldState,
  playerChoices
) {
  const choicesText = Object.entries(playerChoices)
    .map(([name, choice]) => `${name}: ${choice}`)
    .join("\n");

  return `$
WORLD LORE:
${worldPrompt}

CURRENT WORLD STATE:
${currentWorldState}

PLAYER ACTIONS THIS TURN:
${choicesText}

TASK:
Update the world state based on the collective actions of all players.

CRITICAL RULES:
- Describe the OBSERVABLE changes in the world
- Do NOT reveal individual player thoughts or motivations
- Focus on cause and effect
- Show how different actions interact or create new situations
- Maintain consistency with established lore
- The world should feel alive and reactive
- Create natural consequences
- Advance the overall narrative

OUTPUT:
Provide a 2-4 paragraph narration describing what has changed in the world and what new situations have emerged.

Tone: Epic, cinematic, third-person omniscient
Style: Novel-quality prose`;
}

/* =====================
   FIRESTORE HELPERS
===================== */
async function getWorld() {
  const snap = await WORLD_REF.get();
  return snap.exists ? snap.data() : null;
}

async function updateWorld(data) {
  await WORLD_REF.update(data);
}

async function setWorld(data) {
  await WORLD_REF.set(data);
}

/* =====================
   WORLD INITIALIZATION
===================== */
async function initializeWorld() {
  await setWorld({
    status: "SETUP",
    setup: {
      worldPrompt: "",
      systemPrompt: "",
      rolePrompt: ""
    },
    roles: [],
    rolesTaken: [],
    players: {},
    worldState: "",
    currentPhase: 0,
    phaseChoices: {}
  });
}

/* =====================
   PLAYER JOIN (/start)
===================== */
bot.start(async (ctx) => {
  if (ctx.chat.type !== "private") return;

  const world = await getWorld();
  if (!world) {
    await ctx.reply(
      "❌ *Setup incomplete*\n\n" +
      "Please ensure all of the following are filled in Firestore:\n" +
      "• setup.worldPrompt\n" +
      "• setup.systemPrompt\n" +
      "• setup.rolePrompt",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const playerId = String(ctx.from.id);
  const players = world.players || {};

  // Player already registered
  if (players[playerId]) {
    await handleReturningPlayer(ctx, world, playerId);
    return;
  }

  // Check if accepting new players
  if (world.status !== "WAITING_PLAYERS") {
    await ctx.reply("⏳ Currently waiting for other players to join the game");
    return;
  }

  // Check player limit
  if (Object.keys(players).length >= MAX_PLAYERS) {
    const list = Object.values(players)
      .map(p => `• ${p.characterName}`)
      .join("\n");

    await ctx.reply(
      `🚫 *Player limit reached (${MAX_PLAYERS})*\n\n` +
      `Registered players:\n${list}`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  // Accept new player
  awaitingName.add(ctx.from.id);
  await ctx.reply(
    "🌍 *Welcome to the world!*\n\n" +
    "Please enter your *character name*:",
    { parse_mode: "Markdown" }
  );
});

/* =====================
   /INIT COMMAND
===================== */
bot.command("init", async (ctx) => {
  console.log("/INIT hit!");
  if (ctx.chat.id !== ADMIN_GROUP_ID) return;

  const snap = await WORLD_REF.get();

  const world = snap.exists ? snap.data() : null;

  console.log(`data exists - ${snap.exists}, world status - ${world?.status ?? "null"}`);

  if (!snap.exists || world.status === "SETUP") {
    if (!snap.exists || !world?.status) {
      await initializeWorld();
    }

    await ctx.reply(
      "✅ *World initialized*\n\n" +
      "📦 Pseudo database created.\n\n" +
      "✍️ Please manually fill these fields in Firestore:\n" +
      "• setup.worldPrompt\n" +
      "• setup.systemPrompt\n" +
      "• setup.rolePrompt\n\n" +
      "When done, run /done",
      { parse_mode: "Markdown" }
    );
    return;
  }


  let justCompletedRoleExtraction = false;

  if (world.status === "EXTRACT_ROLES_FAILED") {
    console.log("/INIT hit : EXTRACT_ROLES_FAILED");
    const roles = extractRoles(rolePrompt);

    if (roles.length === 0) {
      await ctx.reply(
        "❌ No valid roles found.\n" +
        "Role prompt must be a numbered list.",
        { parse_mode: "Markdown" }
      );

      await updateWorld({
        status: "EXTRACT_ROLES_FAILED",
      });

      return;
    }

    await updateWorld({
      roles,
      rolesTaken: [],
      players: {},          // 🔥 important for fresh session
      status: "WAITING_PLAYERS",
      currentPhase: 0,
      worldState: "",
      phaseChoices: {}
    });

    await ctx.reply(
      "🕰 *Setup complete.*\n\n" +
      "📩 Players may now DM `/start` to join.\n\n" +
      `👥 Max players: ${MAX_PLAYERS}`,
      { parse_mode: "Markdown" }
    );

    justCompletedRoleExtraction = true;
  }

  if (world.status === "WAITING_PLAYERS") {
    console.log("/INIT hit : WAITING_PLAYERS");
    const players = world.players || {};

    let message = "";

    const registered = Object.values(players);

    if (registered.length === 0 && !justCompletedRoleExtraction) {
      message += "🕰 *Awaiting for players.*\n\n" +
        "📩 Players may now DM `/start` to join.\n\n" +
        `👥 Max players: ${MAX_PLAYERS}`;
    } else {
      message += "📋 *Registered Players*\n\n" + registered
        .map(p => `• ${p.characterName}`)
        .join("\n");
    }

    await bot.telegram.sendMessage(
      ADMIN_GROUP_ID,
      message,
      { parse_mode: "Markdown" }
    );
  }

  if (world.status === "ROLE_SELECTION") {
    console.log("/INIT hit : ROLE_SELECTION");

    const players = world.players || {};
    const allSelected = Object.values(players).every(p => p.role);

    if (!allSelected) {
      // Seperate selected and remaining players for role selection
      const selectedPlayers = [];
      const remainingPlayers = [];

      for (const [pid, player] of Object.entries(players)) {
        if (player.role) {
          selectedPlayers.push({
            characterName: player.characterName,
            role: player.role
          });
        } else {
          remainingPlayers.push({
            playerId: pid,
            characterName: player.characterName
          });
        }
      }

      // Role selection status announcement in group
      let message = "🎭 *Role Selection Status*\n\n";

      if (selectedPlayers.length > 0) {
        message += "✅ *Selected Roles:*\n";
        message += selectedPlayers
          .map(p => `• ${p.characterName} → *${p.role}*`)
          .join("\n");
        message += "\n\n";
      }

      if (remainingPlayers.length > 0) {
        message += "⌛ *Waiting on:*\n";
        message += remainingPlayers
          .map(p => `• ${p.characterName}`)
          .join("\n");
      } else {
        message += "🎉 *All players have selected their roles!*";
      }

      await bot.telegram.sendMessage(
        ADMIN_GROUP_ID,
        message,
        { parse_mode: "Markdown" }
      );

      // Send dm to players who have not yet selected their roles
      for (const p of remainingPlayers) {
        try {
          await sendRoleSelection(p.playerId, world);
        } catch (err) {
          console.error(`Failed to DM ${p.characterName}`, err.message);
        }
      }
    };

    // Update status
    await updateWorld({
      status: "RUNNING",
      currentPhase: 1,
      worldState: "The story begins...",
      phaseChoices: {}
    });

    // Generate and send group narration
    await sendGroupNarration(true);

    // Generate and send personal narrations
    await sendPersonalNarrations();
  } else if (world.status === "RUNNING") {
    console.log("/INIT hit : RUNNING");

    await ctx.reply(
      "ℹ️ *World already exists.*\n\n" +
      "If you want to reset the world, run /reset.\n",
      { parse_mode: "Markdown" }
    );
  }
});

/* =====================
   /DONE COMMAND
===================== */
bot.command("done", async (ctx) => {
  if (ctx.chat.id !== ADMIN_GROUP_ID) return;

  const world = await getWorld();
  if (!world) {
    await ctx.reply("❌ World not initialized. Use /init first.");
    return;
  }

  const { worldPrompt, systemPrompt, rolePrompt } = world.setup;

  if (!worldPrompt || !systemPrompt || !rolePrompt) {
    await ctx.reply(
      "❌ *Setup incomplete*\n\n" +
      "Please ensure all of the following are filled in Firestore:\n" +
      "• setup.worldPrompt\n" +
      "• setup.systemPrompt\n" +
      "• setup.rolePrompt",
      { parse_mode: "Markdown" }
    );
    return;
  }

  // Parse roles
  const roles = extractRoles(rolePrompt);

  if (roles.length === 0) {
    await ctx.reply(
      "❌ No valid roles found.\n" +
      "Role prompt must be a numbered list.",
      { parse_mode: "Markdown" }
    );

    await updateWorld({
      status: "EXTRACT_ROLES_FAILED",
    });

    return;
  }

  await updateWorld({
    roles,
    rolesTaken: [],
    players: {},          // 🔥 important for fresh session
    status: "WAITING_PLAYERS",
    currentPhase: 0,
    worldState: "",
    phaseChoices: {}
  });

  await ctx.reply(
    "🕰 *Setup complete.*\n\n" +
    "📩 Players may now DM `/start` to join.\n\n" +
    `👥 Max players: ${MAX_PLAYERS}`,
    { parse_mode: "Markdown" }
  );
});

function extractRoles(rolePrompt) {
  if (!rolePrompt) return [];

  return rolePrompt
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.includes("[ROLE]"))
    .map(l =>
      l
        .split("[ROLE]")[1]   // take text after marker
        .split("(")[0]        // remove (HUMAN) etc
        .trim()
    )
    .filter(Boolean);
}

/* =====================
   RESET COMMAND (Optional)
===================== */
bot.command("reset", async (ctx) => {
  if (ctx.chat.id !== ADMIN_GROUP_ID) return;

  await ctx.reply(
    "⚠️ *WARNING*\n\n" +
    "This will delete all world data and start fresh.\n\n" +
    "Type /confirmreset to proceed.",
    { parse_mode: "Markdown" }
  );
});

bot.command("confirmreset", async (ctx) => {
  if (ctx.chat.id !== ADMIN_GROUP_ID) return;

  await WORLD_REF.delete();
  awaitingName.clear();
  awaitingChoice.clear();
  pendingPrompts.clear();

  await ctx.reply("✅ World reset complete. Use /init to start fresh.");
});

/* =====================
   STATUS COMMAND
===================== */
bot.command("status", async (ctx) => {
  if (ctx.chat.id !== ADMIN_GROUP_ID) return;

  const world = await getWorld();
  if (!world) {
    await ctx.reply("❌ No world exists. Use /init to create one.");
    return;
  }

  const players = world.players || {};
  const playerList = Object.values(players)
    .map(p => `• ${p.characterName} (${p.role || "no role"})`)
    .join("\n") || "None";

  let msg = `📊 *WORLD STATUS*\n\n`;
  msg += `Status: ${world.status}\n`;
  msg += `Phase: ${world.currentPhase || 0}\n`;
  msg += `Players: ${Object.keys(players).length}/${MAX_PLAYERS}\n\n`;
  msg += `Registered:\n${playerList}`;

  await ctx.reply(msg, { parse_mode: "Markdown" });
});

/* =====================
   DEBUG COMMAND (Remove in production)
===================== */
bot.command("debug", async (ctx) => {
  if (ctx.chat.id !== ADMIN_GROUP_ID) return;

  const world = await getWorld();
  const key = "admin_prompt";
  const pending = pendingPrompts.get(key);

  let msg = "🔍 *DEBUG INFO*\n\n";
  msg += `World exists: ${world ? "Yes" : "No"}\n`;

  if (world) {
    msg += `Status: ${world.status}\n`;
    msg += `World prompt length: ${world.setup?.worldPrompt?.length || 0}\n`;
    msg += `System prompt length: ${world.setup?.systemPrompt?.length || 0}\n`;
    msg += `Role prompt length: ${world.setup?.rolePrompt?.length || 0}\n`;
  }

  msg += `\nPending prompt: ${pending ? "Yes" : "No"}\n`;

  if (pending) {
    msg += `Pending type: ${pending.type}\n`;
    msg += `Pending parts: ${pending.parts.length}\n`;
    msg += `Total length: ${pending.parts.join("").length}\n`;
  }

  await ctx.reply(msg, { parse_mode: "Markdown" });
});

/* =====================
   ROLE CALLBACK
===================== */
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (!data.startsWith("ROLE:")) return;

  const chosenRole = data.split(":")[1];
  const playerId = String(ctx.from.id);

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(WORLD_REF);
      const world = snap.data();

      const players = world.players || {};
      const rolesTaken = world.rolesTaken || [];

      if (!players[playerId]) {
        throw new Error("You are not registered.");
      }

      if (players[playerId].role) {
        throw new Error("You already selected a role.");
      }

      if (rolesTaken.includes(chosenRole)) {
        throw new Error("Role already taken. Choose another.");
      }

      players[playerId].role = chosenRole;
      rolesTaken.push(chosenRole);

      tx.update(WORLD_REF, { players, rolesTaken });
    });

    await ctx.editMessageText(
      `✅ You are now: *${chosenRole}*`,
      { parse_mode: "Markdown" }
    );

    const world = await getWorld();
    const characterName = world.players[playerId].characterName;

    await bot.telegram.sendMessage(
      ADMIN_GROUP_ID,
      `🎭 *${characterName}* → *${chosenRole}*`,
      { parse_mode: "Markdown" }
    );

    // Check if all roles selected
    await checkAndStartGame();

  } catch (err) {
    await ctx.answerCbQuery(err.message, { show_alert: true });
  }
});

/* =====================
   PROMPT COLLECTION
===================== */
bot.on("text", async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text;

  // Skip commands
  if (text.startsWith("/")) return;

  // // Handle group messages during setup
  // if (chatId === ADMIN_GROUP_ID) {
  //   const world = await getWorld();
  //   if (!world) return;

  //   const status = world.status;

  //   if (["AWAITING_WORLD_PROMPT", "AWAITING_SYSTEM_PROMPT", "AWAITING_ROLE_PROMPT"].includes(status)) {
  //     // Store as group-level, not user-level
  //     const key = "admin_prompt";

  //     if (!pendingPrompts.has(key)) {
  //       pendingPrompts.set(key, { type: status, parts: [] });
  //     }

  //     const pending = pendingPrompts.get(key);

  //     // Verify we're still collecting the same type
  //     if (pending.type !== status) {
  //       // Reset if status changed
  //       pending.type = status;
  //       pending.parts = [];
  //     }

  //     pending.parts.push(text);

  //     // Only acknowledge first message to avoid spam
  //     if (pending.parts.length === 1) {
  //       await ctx.reply("📝 Message received. Send more if needed, or /done to finalize.");
  //     }
  //   }
  //   return;
  // }

  // Handle DM messages
  if (ctx.chat.type === "private") {
    await handlePrivateMessage(ctx);
  }
});

/* =====================
   ERROR HANDLING
===================== */
bot.catch((err, ctx) => {
  console.error("Bot error:", err);
  console.error("Context:", {
    chat: ctx.chat?.id,
    from: ctx.from?.id,
    message: ctx.message?.text
  });
  ctx.reply("❌ An error occurred. Please try again or contact administrator.");
});

/* =====================
   HANDLE RETURNING PLAYER
===================== */
async function handleReturningPlayer(ctx, world, playerId) {
  const player = world.players[playerId];

  await ctx.reply(
    `✅ Welcome back, *${player.characterName}*!\n\n` +
    `Current status: ${world.status}`,
    { parse_mode: "Markdown" }
  );

  if (world.status === "ROLE_SELECTION" && !player.role) {
    await sendRoleSelection(ctx.from.id, world);
  }

  if (world.status === "RUNNING") {
    await ctx.reply(
      "⏳ The story is in progress.\n\n" +
      "Please respond with your choice: *A*, *B*, or *C*",
      { parse_mode: "Markdown" }
    );
  }
}

/* =====================
   PRIVATE MESSAGE HANDLER
===================== */
async function handlePrivateMessage(ctx) {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  // Name selection
  if (awaitingName.has(userId)) {
    await handleNameSelection(ctx, text);
    return;
  }

  // Choice selection
  if (awaitingChoice.has(userId)) {
    await handleChoiceSelection(ctx, text);
    return;
  }
}

/* =====================
   NAME SELECTION
===================== */
async function handleNameSelection(ctx, name) {
  const world = await getWorld();
  const players = world.players || {};
  const playerId = String(ctx.from.id);

  // Check duplicate name
  const duplicate = Object.values(players).some(
    p => p.characterName.toLowerCase() === name.toLowerCase()
  );

  if (duplicate) {
    await ctx.reply("❌ This name is already taken. Please choose another");
    return;
  }

  // Register player
  players[playerId] = {
    tgName: ctx.from.first_name || ctx.from.username,
    characterName: name,
    role: null,
    currentChoice: null
  };

  await updateWorld({ players });
  awaitingName.delete(ctx.from.id);

  const joined = Object.keys(players).length;

  // Confirm to player
  await ctx.reply(
    "✅ *Character registered!*\n\n" +
    `Waiting for other players... (${joined}/${MAX_PLAYERS})`,
    { parse_mode: "Markdown" }
  );

  // Announce in group
  await bot.telegram.sendMessage(
    ADMIN_GROUP_ID,
    `🧍 *${ctx.from.first_name}* → *${name}*\n` +
    `👥 Players: ${joined}/${MAX_PLAYERS}`,
    { parse_mode: "Markdown" }
  );

  // Start role selection if all players joined
  if (joined === MAX_PLAYERS) {
    await startRoleSelection();
  }
}

/* =====================
   ROLE SELECTION
===================== */
async function startRoleSelection() {
  await updateWorld({ status: "ROLE_SELECTION" });

  const world = await getWorld();

  // Announce in group
  let msg = "🎭 *ROLE SELECTION*\n\n";
  msg += "Available roles:\n";
  world.roles.forEach((r, i) => {
    msg += `${i + 1}. ${r}\n`;
  });
  msg += "\n📩 Players: Check your DM to select roles!";

  await bot.telegram.sendMessage(ADMIN_GROUP_ID, msg, { parse_mode: "Markdown" });

  // Send to each player
  for (const playerId of Object.keys(world.players)) {
    await sendRoleSelection(playerId, world);
  }
}

async function sendRoleSelection(playerId, world) {
  await bot.telegram.sendMessage(
    playerId,
    "🎭 *Choose your role:*",
    {
      parse_mode: "Markdown",
      reply_markup: buildRoleKeyboard(world.roles, world.rolesTaken)
    }
  );
}

// async function resumeRoleSelection() {
//   const world = await getWorld();
//   if (world.status !== "ROLE_SELECTION") return;

//   for (const [playerId, player] of Object.entries(world.players)) {
//     if (!player.role) {
//       await sendRoleSelection(playerId, world);
//     }
//   }
// }

function buildRoleKeyboard(roles, rolesTaken) {
  const available = roles.filter(r => !rolesTaken.includes(r));

  return {
    inline_keyboard: available.map(role => [
      { text: role, callback_data: `ROLE:${role}` }
    ])
  };
}

/* =====================
   START GAME
===================== */
async function checkAndStartGame() {
  const world = await getWorld();
  if (world.status !== "ROLE_SELECTION") return;

  const players = world.players || {};
  const allSelected = Object.values(players).every(p => p.role);

  if (!allSelected) return;

  // Update status
  await updateWorld({
    status: "RUNNING",
    currentPhase: 1,
    worldState: "The story begins...",
    phaseChoices: {}
  });

  // Generate and send group narration
  await sendGroupNarration(true);

  // Generate and send personal narrations
  await sendPersonalNarrations();
}

/* =====================
   GROUP NARRATION
===================== */
async function sendGroupNarration(isFirst = false) {
  const world = await getWorld();

  const groupPrompt = buildGroupNarrationPrompt(
    world.setup.worldPrompt,
    world.worldState,
    world.setup.systemPrompt
  );

  let groupText;
  try {
    groupText = await callGroq(world.setup.systemPrompt, groupPrompt);
  } catch (error) {
    groupText = "The world shifts and changes as the story unfolds...\nThe souls must forge their destiny through hardships and triumphs.";
  }

  const header = isFirst
    ? "🌍 *THE STORY BEGINS*\n\n"
    : `🌍 *WORLD UPDATE - Phase ${world.currentPhase}*\n\n`;

  await bot.telegram.sendMessage(
    ADMIN_GROUP_ID,
    header + groupText,
    { parse_mode: "Markdown" }
  );
}

/* =====================
   PERSONAL NARRATIONS
===================== */
async function sendPersonalNarrations(previousChoices = null) {
  const world = await getWorld();
  const players = world.players;

  // Clear awaiting choices from previous phase
  awaitingChoice.clear();

  for (const [playerId, player] of Object.entries(players)) {
    const personalPrompt = buildPersonalNarrationPrompt(
      world.setup.worldPrompt,
      world.setup.rolePrompt,
      player.characterName,
      player.role,
      world.worldState,
      world.setup.systemPrompt,
      previousChoices ? previousChoices[player.characterName] : null
    );

    let personalText;
    try {
      personalText = await callGroq(world.setup.systemPrompt, personalPrompt);
    } catch (error) {
      personalText = `You stand in the world as ${player.characterName}, a ${player.role}.\n\nA) Look around\nB) Move forward\nC) Wait and observe`;
    }

    await bot.telegram.sendMessage(playerId, personalText);
    awaitingChoice.add(Number(playerId));
  }

  // Reset phase choices
  await updateWorld({ phaseChoices: {} });
}

/* =====================
   CHOICE SELECTION
===================== */
async function handleChoiceSelection(ctx, text) {
  const choice = text.toUpperCase().trim();

  if (!["A", "B", "C"].includes(choice)) {
    await ctx.reply("❌ Please respond with *A*, *B*, or *C*", { parse_mode: "Markdown" });
    return;
  }

  const playerId = String(ctx.from.id);
  const world = await getWorld();
  const player = world.players[playerId];

  if (!player) return;

  // Save choice
  const phaseChoices = world.phaseChoices || {};
  phaseChoices[player.characterName] = choice;

  await updateWorld({
    phaseChoices,
    [`players.${playerId}.currentChoice`]: choice
  });

  awaitingChoice.delete(ctx.from.id);

  await ctx.reply(
    `✅ Choice *${choice}* recorded.\n\n` +
    `Waiting for other players...`,
    { parse_mode: "Markdown" }
  );

  // Check if all choices submitted
  await checkAndProcessPhase();
}

/* =====================
   PROCESS PHASE
===================== */
async function checkAndProcessPhase() {
  const world = await getWorld();
  const players = world.players;
  const phaseChoices = world.phaseChoices || {};

  const allChosen = Object.keys(players).every(
    pid => phaseChoices[players[pid].characterName]
  );

  if (!allChosen) {
    const submittedPlayers = [];
    const remainingPlayers = [];

    for (const pid of Object.keys(players)) {
      const charName = players[pid].characterName;

      if (phaseChoices[charName]) {
        submittedPlayers.push(charName);
      } else {
        remainingPlayers.push(charName);
      }
    }

    let message = "⏳ *Player Choice Status*\n\n";

    if (submittedPlayers.length > 0) {
      message += "✅ *Submitted:*\n";
      message += submittedPlayers.map(n => `• ${n}`).join("\n");
      message += "\n\n";
    }

    if (remainingPlayers.length > 0) {
      message += "⌛ *Waiting on:*\n";
      message += remainingPlayers.map(n => `• ${n}`).join("\n");
    } else {
      message += "🎉 *All players have submitted their choices!*";
    }

    await bot.telegram.sendMessage(
      ADMIN_GROUP_ID,
      message,
      { parse_mode: "Markdown" }
    );

    return;
  };

  // Generate world update
  const updatePrompt = buildWorldUpdatePrompt(
    world.setup.worldPrompt,
    world.setup.systemPrompt,
    world.worldState,
    phaseChoices
  );

  let newWorldState;
  try {
    newWorldState = await callGroq(world.setup.systemPrompt, updatePrompt, 0.9);
  } catch (error) {
    newWorldState = world.worldState + "\n\nThe world continues to evolve...";
  }

  // Update world state and phase
  await updateWorld({
    worldState: newWorldState,
    currentPhase: world.currentPhase + 1,
    phaseChoices: {}
  });

  // Send updated group narration
  await sendGroupNarration();

  // Send next personal narrations
  await sendPersonalNarrations(phaseChoices);
}

/* =====================
   SERVER & LAUNCH
===================== */
app.get("/", (req, res) => {
  res.send("🤖 Telegram RPG Bot is running");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

bot.launch().then(() => {
  console.log("✅ Bot started successfully");
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

// Graceful shutdown
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
