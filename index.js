const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const pvp = require("mineflayer-pvp").plugin;
const collectBlock = require("mineflayer-collectblock").plugin;
const { GoogleGenAI } = require("@google/genai");
const express = require("express");

// ============================================================
// CONFIG
// ============================================================

const HOST = "loobialimoosmp.aternos.me";
const PORT = 58114;
const VERSION = "1.21.8";
const BOT_USERNAME = "KadooBot";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ============================================================
// WEB SERVER
// ============================================================

const app = express();

app.get("/", (req, res) => {
    res.send("KadooBot AI is online.");
});

app.get("/health", (req, res) => {
    res.json({
        bot: BOT_USERNAME,
        connected: bot?.entity != null,
        position: bot?.entity?.position || null
    });
});

const WEB_PORT = process.env.PORT || 3000;

app.listen(WEB_PORT, () => {
    console.log(`Web server running on port ${WEB_PORT}`);
});

// ============================================================
// GEMINI
// ============================================================

if (!GEMINI_API_KEY) {
    console.error("ERROR: GEMINI_API_KEY is missing!");
    process.exit(1);
}

const ai = new GoogleGenAI({
    apiKey: GEMINI_API_KEY
});

const MODEL = "gemini-2.5-flash";

// ============================================================
// MINEFLAYER
// ============================================================

const bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: BOT_USERNAME,
    version: VERSION,
    auth: "offline"
});

bot.loadPlugin(pathfinder);
bot.loadPlugin(pvp);
bot.loadPlugin(collectBlock);

// ============================================================
// STATE
// ============================================================

let defaultMovements;
let followingPlayer = null;
let protectingPlayer = null;
let busy = false;

// ============================================================
// SPAWN
// ============================================================

bot.once("spawn", () => {

    console.log("=================================");
    console.log("KadooBot joined Minecraft!");
    console.log("=================================");

    const mcData = require("minecraft-data")(bot.version);

    defaultMovements = new Movements(bot, mcData);

    bot.pathfinder.setMovements(defaultMovements);

    bot.chat("KadooBot AI is online!");
    bot.chat("Talk to me normally.");
});

// ============================================================
// BASIC INFORMATION
// ============================================================

function getWorldState() {

    if (!bot.entity) {
        return "Bot is not currently spawned.";
    }

    const nearbyPlayers = Object.keys(bot.players)
        .filter(name => name !== bot.username)
        .join(", ");

    const inventory = bot.inventory.items()
        .map(item => `${item.name} x${item.count}`)
        .join(", ");

    return `
Position:
X=${Math.floor(bot.entity.position.x)}
Y=${Math.floor(bot.entity.position.y)}
Z=${Math.floor(bot.entity.position.z)}

Nearby players:
${nearbyPlayers || "none"}

Inventory:
${inventory || "empty"}

Health:
${bot.health}

Food:
${bot.food}
`;
}

// ============================================================
// FOLLOW
// ============================================================

async function followPlayer(playerName) {

    const player = bot.players[playerName];

    if (!player || !player.entity) {
        return `I cannot see ${playerName}.`;
    }

    followingPlayer = playerName;

    bot.pathfinder.setGoal(
        new goals.GoalFollow(player.entity, 2),
        true
    );

    return `I'm following ${playerName}.`;
}

// ============================================================
// COME TO PLAYER
// ============================================================

async function comeToPlayer(playerName) {

    const player = bot.players[playerName];

    if (!player || !player.entity) {
        return `I cannot see ${playerName}.`;
    }

    followingPlayer = null;

    bot.pathfinder.setGoal(
        new goals.GoalNear(
            player.entity.position.x,
            player.entity.position.y,
            player.entity.position.z,
            2
        )
    );

    return `I'm coming to you.`;
}

// ============================================================
// STOP
// ============================================================

async function stopEverything() {

    followingPlayer = null;
    protectingPlayer = null;

    bot.pathfinder.setGoal(null);

    try {
        bot.pvp.stop();
    } catch {}

    return "Okay, I stopped.";
}

// ============================================================
// PROTECT
// ============================================================

async function protectPlayer(playerName) {

    const player = bot.players[playerName];

    if (!player || !player.entity) {
        return `I cannot see ${playerName}.`;
    }

    protectingPlayer = playerName;

    return `I'll protect ${playerName}.`;
}

// ============================================================
// FIND BLOCK
// ============================================================

function findBlock(blockName, distance = 64) {

    const blockType = bot.registry.blocksByName[blockName];

    if (!blockType) {
        return null;
    }

    return bot.findBlock({
        matching: blockType.id,
        maxDistance: distance
    });
}

// ============================================================
// MINE BLOCK
// ============================================================

async function mineBlock(blockName, amount = 1) {

    const blockType = bot.registry.blocksByName[blockName];

    if (!blockType) {
        return `I don't know what "${blockName}" is.`;
    }

    let mined = 0;

    for (let i = 0; i < amount; i++) {

        const block = findBlock(blockName);

        if (!block) {
            return `I found ${mined} ${blockName}, but I can't find any more nearby.`;
        }

        try {

            await bot.collectBlock.collect(block);

            mined++;

        } catch (error) {

            console.log("Mining error:", error);

            return `I tried mining ${blockName}, but something stopped me.`;
        }
    }

    return `I mined ${mined} ${blockName}.`;
}

// ============================================================
// ATTACK NEARBY MOB
// ============================================================

async function attackNearestMob() {

    const hostileNames = [
        "zombie",
        "skeleton",
        "creeper",
        "spider",
        "enderman",
        "witch",
        "pillager",
        "vindicator",
        "phantom"
    ];

    const mob = bot.nearestEntity(entity => {

        if (!entity || !entity.position) return false;

        if (entity.type !== "mob") return false;

        if (!hostileNames.includes(entity.name)) return false;

        return entity.position.distanceTo(bot.entity.position) < 16;
    });

    if (!mob) {
        return "There are no hostile mobs nearby.";
    }

    bot.pvp.attack(mob);

    return `I'm attacking the ${mob.name}.`;
}

// ============================================================
// CHAT AI
// ============================================================

async function askAI(playerName, message) {

    if (busy) {
        bot.chat(`${playerName}, I'm already doing something.`);
        return;
    }

    busy = true;

    try {

        const worldState = getWorldState();

        const prompt = `
You are KadooBot, an AI companion living inside a Minecraft Java 1.21.8 world.

Your owner/player is: ${playerName}

You can control the Minecraft world through actions.

IMPORTANT:
- Do not claim you performed an action unless you actually call the corresponding action.
- Keep responses short because they will appear in Minecraft chat.
- Understand natural language.
- If the player asks you to follow them, follow them.
- If they ask you to protect them, protect them.
- If they ask you to come, come.
- If they ask you to stop, stop.
- If they ask you to mine something, mine it.
- If they ask you to attack something, attack it.
- If something is impossible, explain briefly.
- Never pretend to have items that you don't have.

Current world state:

${worldState}

Player request:

${message}

Decide what should happen.

Return ONLY valid JSON in this format:

{
  "action": "follow|come|stop|protect|mine|attack|chat",
  "target": "optional target",
  "amount": 1,
  "response": "short response to the player"
}

Examples:

Player:
"follow me"

{
  "action": "follow",
  "response": "Okay, I'm following you."
}

Player:
"come here"

{
  "action": "come",
  "response": "Coming."
}

Player:
"protect me"

{
  "action": "protect",
  "response": "I'll protect you."
}

Player:
"mine 10 stone"

{
  "action": "mine",
  "target": "stone",
  "amount": 10,
  "response": "I'll mine some stone."
}

Player:
"stop"

{
  "action": "stop",
  "response": "Stopping."
}
`;

        const result = await ai.models.generateContent({
            model: MODEL,
            contents: prompt
        });

        let text = result.text.trim();

        // Remove markdown code fences if Gemini adds them
        text = text
            .replace(/^```json/i, "")
            .replace(/^```/i, "")
            .replace(/```$/i, "")
            .trim();

        console.log("AI:", text);

        let command;

        try {
            command = JSON.parse(text);
        } catch (error) {

            console.log("AI JSON error:", error);

            bot.chat("I didn't understand that properly.");

            busy = false;
            return;
        }

        let resultMessage = command.response || "Okay.";

        switch (command.action) {

            case "follow":
                resultMessage = await followPlayer(playerName);
                break;

            case "come":
                resultMessage = await comeToPlayer(playerName);
                break;

            case "stop":
                resultMessage = await stopEverything();
                break;

            case "protect":
                resultMessage = await protectPlayer(playerName);
                break;

            case "mine":
                resultMessage = await mineBlock(
                    command.target,
                    Math.min(command.amount || 1, 32)
                );
                break;

            case "attack":
                resultMessage = await attackNearestMob();
                break;

            case "chat":
                break;

            default:
                resultMessage = command.response || "Okay.";
        }

        bot.chat(resultMessage);

    } catch (error) {

        console.error("AI ERROR:", error);

        bot.chat("My AI brain is having trouble right now.");

    } finally {

        busy = false;

    }
}

// ============================================================
// CHAT LISTENER
// ============================================================

bot.on("chat", async (username, message) => {

    if (username === bot.username) return;

    console.log(`[CHAT] ${username}: ${message}`);

    // Only respond when Kadoo is mentioned.
    const lower = message.toLowerCase();

    if (
        !lower.includes("kadoo") &&
        !lower.startsWith("!k")
    ) {
        return;
    }

    let cleanMessage = message
        .replace(/kadoobot/gi, "")
        .replace(/kadoo/gi, "")
        .replace(/^!k\s*/i, "")
        .trim();

    if (!cleanMessage) {
        bot.chat(`Yes, ${username}?`);
        return;
    }

    await askAI(username, cleanMessage);
});

// ============================================================
// PHYSICS LOOP
// ============================================================

bot.on("physicsTick", () => {

    // Follow target
    if (followingPlayer) {

        const player = bot.players[followingPlayer];

        if (player && player.entity) {

            bot.pathfinder.setGoal(
                new goals.GoalFollow(player.entity, 2),
                true
            );
        }
    }

    // Protection
    if (protectingPlayer) {

        const player = bot.players[protectingPlayer];

        if (!player || !player.entity) return;

        const hostileNames = [
            "zombie",
            "skeleton",
            "creeper",
            "spider",
            "enderman",
            "witch",
            "pillager",
            "vindicator",
            "phantom"
        ];

        const mob = bot.nearestEntity(entity => {

            if (!entity || entity.type !== "mob") {
                return false;
            }

            if (!hostileNames.includes(entity.name)) {
                return false;
            }

            const distanceToPlayer =
                entity.position.distanceTo(player.entity.position);

            const distanceToBot =
                entity.position.distanceTo(bot.entity.position);

            return distanceToPlayer < 12 &&
                   distanceToBot < 16;
        });

        if (mob) {

            try {
                bot.pvp.attack(mob);
            } catch {}
        }
    }
});

// ============================================================
// CONNECTION EVENTS
// ============================================================

bot.on("kicked", reason => {

    console.log("Kicked:", reason);

    setTimeout(() => {
        process.exit(1);
    }, 5000);
});

bot.on("error", error => {

    console.error("Mineflayer error:", error);
});

bot.on("end", () => {

    console.log("Disconnected from Minecraft.");

    setTimeout(() => {
        process.exit(1);
    }, 5000);
});
