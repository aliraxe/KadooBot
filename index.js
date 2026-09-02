const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const pvp = require("mineflayer-pvp").plugin;
const collectBlock = require("mineflayer-collectblock").plugin;
const { GoogleGenAI } = require("@google/genai");
const express = require("express");
const fs = require("fs");

// ============================================================
// CONFIG
// ============================================================

const HOST = "loobialimoosmp.aternos.me";
const PORT = 58114;
const VERSION = "1.21.8";
const BOT_USERNAME = "KadooBot";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-3.6-flash";

const MAX_PLAN_STEPS = 20;
const MAX_MINE_AMOUNT = 64;
const LOCATION_FILE = "./locations.json";

// ============================================================
// WEB SERVER
// ============================================================

const app = express();

app.get("/", (req, res) => {
    res.send("KadooBot V3 is online.");
});

app.get("/health", (req, res) => {
    res.json({
        bot: BOT_USERNAME,
        connected: !!bot?.entity,
        position: bot?.entity?.position || null,
        task: currentTask,
        following: followingPlayer,
        protecting: protectingPlayer,
        health: bot?.health ?? null,
        food: bot?.food ?? null
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

let mcData = null;
let defaultMovements = null;

let followingPlayer = null;
let protectingPlayer = null;

let currentTask = null;
let taskRunning = false;
let taskId = 0;

let lastProtectionCheck = 0;
let lastSurvivalCheck = 0;
let lastDoorCheck = 0;
let lastSelfDefenseCheck = 0;
let lastGearCheck = 0;

let stuckSince = 0;
let lastPosition = null;

// ============================================================
// LOCATION MEMORY
// ============================================================

let locations = {};

function loadLocations() {
    try {
        if (fs.existsSync(LOCATION_FILE)) {
            locations = JSON.parse(
                fs.readFileSync(LOCATION_FILE, "utf8")
            );
        }
    } catch (error) {
        console.log("Could not load locations:", error.message);
        locations = {};
    }
}

function saveLocations() {
    try {
        fs.writeFileSync(
            LOCATION_FILE,
            JSON.stringify(locations, null, 2)
        );
    } catch (error) {
        console.log("Could not save locations:", error.message);
    }
}

function getCurrentPosition() {
    if (!bot.entity) return null;

    return {
        x: Math.floor(bot.entity.position.x),
        y: Math.floor(bot.entity.position.y),
        z: Math.floor(bot.entity.position.z)
    };
}

// ============================================================
// SPAWN
// ============================================================

bot.once("spawn", () => {
    console.log("=================================");
    console.log("KadooBot V3 joined Minecraft!");
    console.log("=================================");

    mcData = require("minecraft-data")(bot.version);

    defaultMovements = new Movements(bot, mcData);

    // IMPORTANT:
    // Do not destroy blocks simply because pathfinding wants
    // to get through somewhere.
    defaultMovements.canDig = false;

    // Prevent weird pillar behavior.
    defaultMovements.allow1by1towers = false;

    // Do not make dangerous large drops.
    defaultMovements.maxDropDown = 3;

    // Let pathfinder open doors/gates itself while walking a path.
    // (mineflayer-pathfinder ships this OFF by default; we back it
    // up with a manual watchdog below since it isn't 100% reliable
    // on its own, especially during GoalFollow.)
    defaultMovements.canOpenDoors = true;

    bot.pathfinder.setMovements(defaultMovements);

    loadLocations();

    bot.chat("KadooBot V3 is online!");
    bot.chat("I can move, mine, fight, craft, remember places and do tasks.");

    console.log("Loaded locations:", locations);

    // Put on whatever armor we're carrying right away.
    equipArmor().catch(() => {});
});

// ============================================================
// CHAT
// ============================================================

bot.on("chat", async (username, message) => {
    if (username === bot.username) return;

    console.log(`[CHAT] ${username}: ${message}`);

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

    const normalized = cleanMessage.toLowerCase().trim();

    // Stop should work even while another task is running.
    if (
        normalized === "stop" ||
        normalized.includes("stop what you're doing") ||
        normalized.includes("stop everything")
    ) {
        const response = await stopEverything();
        bot.chat(response);
        return;
    }

    // Fast-path commands: skip the AI round-trip for a handful of
    // common, safety-relevant requests so they're instant and never
    // fail because of a bad AI response.

    if (
        normalized === "sethome" ||
        normalized === "set home" ||
        normalized === "remember this as home" ||
        normalized === "this is home"
    ) {
        bot.chat(await rememberLocation("home"));
        return;
    }

    if (
        normalized === "go home" ||
        normalized === "gohome" ||
        normalized === "come home" ||
        normalized === "return home"
    ) {
        bot.chat(await goToLocation("home"));
        return;
    }

    if (
        normalized === "gear up" ||
        normalized === "gearup" ||
        normalized === "equip gear" ||
        normalized === "equip your gear"
    ) {
        bot.chat(await gearUp());
        return;
    }

    if (
        normalized === "sort inventory" ||
        normalized === "sort your inventory" ||
        normalized === "sort my inventory" ||
        normalized === "tidy inventory" ||
        normalized === "tidy up your inventory"
    ) {
        bot.chat(await sortInventory());
        return;
    }

    await askAI(username, cleanMessage);
});

// ============================================================
// WORLD STATE
// ============================================================

function getInventorySummary() {
    if (!bot.inventory) return "unknown";

    const items = {};

    for (const item of bot.inventory.items()) {
        items[item.name] = (items[item.name] || 0) + item.count;
    }

    return Object.entries(items)
        .map(([name, count]) => `${name} x${count}`)
        .join(", ") || "empty";
}

function getEquippedSummary() {
    if (!bot.inventory) return "unknown";

    const slots = bot.inventory.slots;
    const names = [];

    // 5 = head, 6 = torso, 7 = legs, 8 = feet in mineflayer's slot map.
    for (const slotIndex of [5, 6, 7, 8]) {
        const item = slots[slotIndex];
        if (item) names.push(item.name);
    }

    const heldItem = bot.heldItem;
    if (heldItem) names.push(`${heldItem.name} (hand)`);

    return names.join(", ") || "nothing";
}

function getNearbyPlayers() {
    return Object.values(bot.players)
        .filter(p => p.username !== bot.username)
        .map(p => {
            if (!p.entity) {
                return `${p.username} (not visible)`;
            }

            const pos = p.entity.position;

            return `${p.username} (${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)})`;
        })
        .join(", ") || "none";
}

function getNearbyEntities() {
    if (!bot.entity) return "none";

    return Object.values(bot.entities)
        .filter(entity => {
            if (!entity || !entity.position) return false;

            return entity.position.distanceTo(bot.entity.position) <= 16;
        })
        .filter(entity => entity.type === "mob")
        .map(entity => {
            return `${entity.name || "unknown"} (${Math.floor(entity.position.x)}, ${Math.floor(entity.position.y)}, ${Math.floor(entity.position.z)})`;
        })
        .slice(0, 30)
        .join(", ") || "none";
}

function getWorldState() {
    if (!bot.entity) {
        return "Bot is not spawned.";
    }

    const p = getCurrentPosition();

    return `
POSITION:
X=${p.x}
Y=${p.y}
Z=${p.z}

HEALTH:
${bot.health}/20

FOOD:
${bot.food}/20

PLAYERS:
${getNearbyPlayers()}

NEARBY MOBS:
${getNearbyEntities()}

INVENTORY:
${getInventorySummary()}

EQUIPPED:
${getEquippedSummary()}

MEMORIZED LOCATIONS:
${Object.keys(locations).length
    ? Object.entries(locations)
        .map(([name, p]) =>
            `${name}: ${p.x}, ${p.y}, ${p.z}`
        )
        .join(" | ")
    : "none"}

CURRENT TASK:
${currentTask || "idle"}

FOLLOWING:
${followingPlayer || "none"}

PROTECTING:
${protectingPlayer || "none"}
`;
}

// ============================================================
// BASIC MOVEMENT
// ============================================================

async function followPlayer(playerName) {
    const player = bot.players[playerName];

    if (!player || !player.entity) {
        return `I cannot see ${playerName}.`;
    }

    followingPlayer = playerName;
    protectingPlayer = null;

    bot.pathfinder.setGoal(
        new goals.GoalFollow(player.entity, 2),
        true
    );

    return `I'm following ${playerName}.`;
}

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

async function goToCoordinates(x, y, z) {
    followingPlayer = null;

    bot.pathfinder.setGoal(
        new goals.GoalNear(
            Number(x),
            Number(y),
            Number(z),
            1
        )
    );

    return `I'm going to ${Math.floor(x)}, ${Math.floor(y)}, ${Math.floor(z)}.`;
}

// ============================================================
// STOP
// ============================================================

async function stopEverything() {
    taskId++;

    currentTask = null;
    taskRunning = false;

    followingPlayer = null;
    protectingPlayer = null;

    bot.pathfinder.setGoal(null);

    try {
        bot.pvp.stop();
    } catch {}

    try {
        bot.clearControlStates();
    } catch {}

    return "Okay, I stopped everything.";
}

// ============================================================
// GEAR / ARMOR / WEAPONS
// ============================================================

const ARMOR_SLOTS = {
    head: [
        "diamond_helmet",
        "iron_helmet",
        "chainmail_helmet",
        "golden_helmet",
        "turtle_helmet",
        "leather_helmet"
    ],
    torso: [
        "diamond_chestplate",
        "iron_chestplate",
        "chainmail_chestplate",
        "golden_chestplate",
        "leather_chestplate"
    ],
    legs: [
        "diamond_leggings",
        "iron_leggings",
        "chainmail_leggings",
        "golden_leggings",
        "leather_leggings"
    ],
    feet: [
        "diamond_boots",
        "iron_boots",
        "chainmail_boots",
        "golden_boots",
        "leather_boots"
    ]
};

const WEAPON_ORDER = [
    "netherite_sword",
    "diamond_sword",
    "iron_sword",
    "stone_sword",
    "golden_sword",
    "wooden_sword",
    "netherite_axe",
    "diamond_axe",
    "iron_axe",
    "stone_axe",
    "golden_axe",
    "wooden_axe"
];

// Only touches armor slots, never the hand, so it's safe to run in
// the background even while mining/fighting/building.
async function equipArmor() {
    if (!bot.inventory) return false;

    let equippedAny = false;

    for (const [slot, items] of Object.entries(ARMOR_SLOTS)) {
        for (const name of items) {
            const item = findInventoryItem(name);

            if (!item) continue;

            const currentlyWorn = getWornArmorName(slot);

            if (currentlyWorn === name) break;

            try {
                await bot.equip(item, slot);
                equippedAny = true;
            } catch (error) {
                console.log("Armor equip error:", error.message);
            }

            break;
        }
    }

    return equippedAny;
}

function getWornArmorName(slot) {
    const slotIndexes = { head: 5, torso: 6, legs: 7, feet: 8 };
    const index = slotIndexes[slot];

    if (index == null || !bot.inventory) return null;

    const item = bot.inventory.slots[index];

    return item ? item.name : null;
}

// Only call this right before combat - it touches the hand slot,
// which would otherwise fight with pickaxe-swapping during mining.
async function equipBestWeapon() {
    for (const name of WEAPON_ORDER) {
        const item = findInventoryItem(name);

        if (item) {
            try {
                await bot.equip(item, "hand");
                return true;
            } catch (error) {
                console.log("Weapon equip error:", error.message);
            }
        }
    }

    return false;
}

async function equipShield() {
    const shield = findInventoryItem("shield");

    if (!shield) return false;

    try {
        await bot.equip(shield, "off-hand");
        return true;
    } catch {
        return false;
    }
}

async function gearUp() {
    const armorDone = await equipArmor();
    const weaponDone = await equipBestWeapon();
    await equipShield();

    return armorDone || weaponDone
        ? "I geared up."
        : "I don't have any armor or weapons to equip.";
}

// ============================================================
// PROTECTION / SELF-DEFENSE
// ============================================================

const HOSTILE_MOBS = new Set([
    "zombie",
    "skeleton",
    "stray",
    "husk",
    "drowned",
    "creeper",
    "spider",
    "cave_spider",
    "enderman",
    "witch",
    "pillager",
    "vindicator",
    "evoker",
    "ravager",
    "vex",
    "phantom",
    "silverfish",
    "endermite",
    "piglin",
    "piglin_brute",
    "zoglin",
    "hoglin",
    "warden"
]);

function isHostile(entity) {
    return (
        entity &&
        entity.type === "mob" &&
        HOSTILE_MOBS.has(entity.name)
    );
}

async function protectPlayer(playerName) {
    const player = bot.players[playerName];

    if (!player || !player.entity) {
        return `I cannot see ${playerName}.`;
    }

    followingPlayer = null;
    protectingPlayer = playerName;

    return `I'll protect ${playerName}.`;
}

function findThreatNearPlayer(playerEntity) {
    if (!playerEntity) return null;

    return bot.nearestEntity(entity => {
        if (!isHostile(entity)) return false;

        const distance =
            entity.position.distanceTo(playerEntity.position);

        return distance <= 12;
    });
}

async function protectTick() {
    if (!protectingPlayer || !bot.entity) return;

    const player = bot.players[protectingPlayer];

    if (!player || !player.entity) {
        return;
    }

    const threat = findThreatNearPlayer(player.entity);

    if (!threat) {
        // Stay reasonably close to the protected player.
        const distance =
            bot.entity.position.distanceTo(player.entity.position);

        if (distance > 6 && !taskRunning) {
            bot.pathfinder.setGoal(
                new goals.GoalNear(
                    player.entity.position.x,
                    player.entity.position.y,
                    player.entity.position.z,
                    4
                )
            );
        }

        return;
    }

    // Creepers need special treatment.
    if (
        threat.name === "creeper" &&
        threat.position.distanceTo(player.entity.position) < 5
    ) {
        try {
            bot.pvp.stop();
        } catch {}

        // Move away from the creeper rather than blindly hitting it.
        const awayX =
            bot.entity.position.x -
            (threat.position.x - bot.entity.position.x) * 5;

        const awayZ =
            bot.entity.position.z -
            (threat.position.z - bot.entity.position.z) * 5;

        bot.pathfinder.setGoal(
            new goals.GoalXZ(
                Math.floor(awayX),
                Math.floor(awayZ)
            )
        );

        return;
    }

    try {
        await equipBestWeapon();
        bot.pvp.attack(threat);
    } catch {}
}

// Self-preservation: runs ALL the time, not just while "protecting"
// someone, so the bot fights back or flees even when idle/alone.
async function selfDefenseTick() {
    if (!bot.entity) return;

    // Critical health: disengage and run from the nearest threat.
    if (bot.health <= 6) {
        try {
            bot.pvp.stop();
        } catch {}

        const threat = bot.nearestEntity(entity => {
            return (
                isHostile(entity) &&
                entity.position.distanceTo(bot.entity.position) <= 8
            );
        });

        if (threat) {
            const awayX =
                bot.entity.position.x -
                (threat.position.x - bot.entity.position.x) * 4;

            const awayZ =
                bot.entity.position.z -
                (threat.position.z - bot.entity.position.z) * 4;

            bot.pathfinder.setGoal(
                new goals.GoalXZ(
                    Math.floor(awayX),
                    Math.floor(awayZ)
                )
            );
        }

        return;
    }

    // Already mid-fight (protectTick or a manual attack) - don't
    // double-target.
    if (bot.pvp.target) return;

    const threat = bot.nearestEntity(entity => {
        return (
            isHostile(entity) &&
            entity.position.distanceTo(bot.entity.position) <= 6
        );
    });

    if (threat) {
        try {
            await equipBestWeapon();
            bot.pvp.attack(threat);
        } catch {}
    }
}

// ============================================================
// BLOCK SEARCH
// ============================================================

function findBlock(blockName, distance = 64) {
    if (!bot.registry || !bot.registry.blocksByName) {
        return null;
    }

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
// INVENTORY
// ============================================================

function countItem(itemName) {
    return bot.inventory.items()
        .filter(item => item.name === itemName)
        .reduce((total, item) => total + item.count, 0);
}

function findInventoryItem(itemName) {
    return bot.inventory.items()
        .find(item => item.name === itemName);
}

function getFirstFood() {
    // Cooked/prepared food first (best saturation), then raw food as
    // a fallback so the bot never starves just because nothing is
    // cooked yet.
    const foods = [
        "cooked_beef",
        "cooked_porkchop",
        "cooked_chicken",
        "cooked_mutton",
        "cooked_rabbit",
        "cooked_cod",
        "cooked_salmon",
        "bread",
        "baked_potato",
        "golden_carrot",
        "apple",
        "carrot",
        "potato",
        "beetroot",
        "beef",
        "porkchop",
        "chicken",
        "mutton",
        "rabbit",
        "cod",
        "salmon",
        "rotten_flesh"
    ];

    for (const name of foods) {
        const item = findInventoryItem(name);

        if (item) return item;
    }

    return null;
}

// ============================================================
// EATING
// ============================================================

async function eatFood() {
    const food = getFirstFood();

    if (!food) {
        return "I don't have any food.";
    }

    try {
        await bot.equip(food, "hand");
        await bot.consume();

        return `I ate ${food.name}.`;
    } catch (error) {
        console.log("Eat error:", error.message);
        return "I couldn't eat right now.";
    }
}

// ============================================================
// COOKING
// ============================================================

const RAW_TO_COOKED = {
    beef: "cooked_beef",
    porkchop: "cooked_porkchop",
    chicken: "cooked_chicken",
    mutton: "cooked_mutton",
    rabbit: "cooked_rabbit",
    cod: "cooked_cod",
    salmon: "cooked_salmon",
    potato: "baked_potato"
};

async function findNearbyFurnace() {
    return bot.findBlock({
        matching: block => {
            if (!block) return false;

            return (
                block.name === "furnace" ||
                block.name === "blast_furnace" ||
                block.name === "smoker"
            );
        },
        maxDistance: 8
    });
}

async function cookFood() {
    const furnaceBlock = await findNearbyFurnace();

    if (!furnaceBlock) {
        return "I can't find a furnace nearby.";
    }

    let rawItem = null;
    let rawName = null;

    for (const raw of Object.keys(RAW_TO_COOKED)) {
        const item = findInventoryItem(raw);

        if (item) {
            rawItem = item;
            rawName = raw;
            break;
        }
    }

    if (!rawItem) {
        return "I don't have any raw food to cook.";
    }

    const fuel =
        findInventoryItem("coal") ||
        findInventoryItem("charcoal") ||
        findInventoryItem("oak_planks") ||
        findInventoryItem("stick");

    if (!fuel) {
        return "I don't have any fuel to cook with.";
    }

    try {
        const furnace = await bot.openFurnace(furnaceBlock);

        await furnace.putFuel(fuel.type, null, Math.min(fuel.count, 8));
        await furnace.putInput(rawItem.type, null, rawItem.count);

        // Give it time to smelt (roughly 10s/item, capped).
        const waitMs = Math.min(rawItem.count * 10000, 60000);

        await new Promise(resolve => setTimeout(resolve, waitMs));

        try {
            await furnace.takeOutput();
        } catch {}

        furnace.close();

        return `I cooked some ${rawName}.`;
    } catch (error) {
        console.log("Cook error:", error.message);
        return "I couldn't cook right now.";
    }
}

// ============================================================
// SURVIVAL
// ============================================================

async function survivalCheck() {
    if (!bot.entity) return;

    // Very low health: stop combat and retreat toward a safer position.
    if (bot.health <= 5) {
        try {
            bot.pvp.stop();
        } catch {}

        if (!taskRunning) {
            bot.pathfinder.setGoal(null);
        }
    }

    // Eat when hungry - this now runs even during a task, so the bot
    // doesn't starve mid-build or mid-mine.
    if (bot.food <= 14) {
        await eatFood();
    }
}

// ============================================================
// TOOL MANAGEMENT
// ============================================================

const TOOL_MATERIALS = {
    wooden: "oak_planks",
    stone: "cobblestone",
    iron: "iron_ingot",
    diamond: "diamond"
};

const TOOL_ORDER = [
    "diamond_pickaxe",
    "iron_pickaxe",
    "stone_pickaxe",
    "wooden_pickaxe"
];

async function equipBestPickaxe() {
    for (const name of TOOL_ORDER) {
        const item = findInventoryItem(name);

        if (item) {
            try {
                await bot.equip(item, "hand");
                return true;
            } catch {}
        }
    }

    return false;
}

async function craftItem(itemName, amount = 1) {
    if (!mcData) {
        return "Minecraft data isn't ready yet.";
    }

    const item = mcData.itemsByName[itemName];

    if (!item) {
        return `I don't know the item ${itemName}.`;
    }

    let crafted = 0;

    for (let i = 0; i < amount; i++) {
        const recipes = bot.recipesFor(
            item.id,
            null,
            1,
            null
        );

        if (!recipes || recipes.length === 0) {
            return crafted > 0
                ? `I crafted ${crafted} ${itemName}, but I can't craft more.`
                : `I don't have the materials to craft ${itemName}.`;
        }

        try {
            await bot.craft(recipes[0], 1);

            crafted++;
        } catch (error) {
            console.log("Craft error:", error.message);

            return crafted > 0
                ? `I crafted ${crafted} ${itemName}.`
                : `I couldn't craft ${itemName}.`;
        }
    }

    return `I crafted ${crafted} ${itemName}.`;
}

// ============================================================
// BASIC TOOL AUTO-PROGRESSION
// ============================================================

async function ensurePickaxe() {
    if (countItem("diamond_pickaxe") > 0) {
        await equipBestPickaxe();
        return true;
    }

    if (countItem("iron_pickaxe") > 0) {
        await equipBestPickaxe();
        return true;
    }

    if (countItem("stone_pickaxe") > 0) {
        await equipBestPickaxe();
        return true;
    }

    if (countItem("wooden_pickaxe") > 0) {
        await equipBestPickaxe();
        return true;
    }

    // Try crafting wooden pickaxe.
    if (countItem("oak_planks") >= 3 && countItem("stick") >= 2) {
        const result = await craftItem("wooden_pickaxe", 1);

        if (countItem("wooden_pickaxe") > 0) {
            await equipBestPickaxe();
            return true;
        }

        console.log(result);
    }

    return false;
}

// ============================================================
// MINING
// ============================================================

async function mineBlock(blockName, amount = 1) {
    amount = Math.max(
        1,
        Math.min(Number(amount) || 1, MAX_MINE_AMOUNT)
    );

    if (!bot.registry.blocksByName[blockName]) {
        return `I don't know what "${blockName}" is.`;
    }

    let mined = 0;

    for (let i = 0; i < amount; i++) {
        if (taskId < 0) break;

        const block = findBlock(blockName, 64);

        if (!block) {
            return mined > 0
                ? `I mined ${mined} ${blockName}, but I can't find more nearby.`
                : `I can't find any ${blockName} nearby.`;
        }

        try {
            await ensurePickaxe();

            await bot.collectBlock.collect(block);

            mined++;

            if (bot.food <= 5) {
                await eatFood();
            }
        } catch (error) {
            console.log("Mining error:", error.message);

            return mined > 0
                ? `I mined ${mined} ${blockName}, then something stopped me.`
                : `I couldn't mine ${blockName}.`;
        }
    }

    return `I mined ${mined} ${blockName}.`;
}

// ============================================================
// GATHER WOOD
// ============================================================

async function gatherWood(amount = 8) {
    const treeBlocks = [
        "oak_log",
        "birch_log",
        "spruce_log",
        "jungle_log",
        "acacia_log",
        "dark_oak_log",
        "mangrove_log",
        "cherry_log"
    ];

    let collected = 0;

    while (collected < amount) {
        let block = null;

        for (const name of treeBlocks) {
            block = findBlock(name, 64);

            if (block) break;
        }

        if (!block) {
            return collected > 0
                ? `I gathered ${collected} logs, but can't find more trees nearby.`
                : "I can't find a tree nearby.";
        }

        try {
            await bot.collectBlock.collect(block);

            collected++;
        } catch (error) {
            console.log("Wood gathering error:", error.message);
            break;
        }
    }

    return `I gathered ${collected} logs.`;
}

// ============================================================
// CRAFT STARTER TOOLS
// ============================================================

async function craftStarterTools() {
    let messages = [];

    // Convert logs to planks if possible.
    const logs = [
        "oak_log",
        "birch_log",
        "spruce_log",
        "jungle_log",
        "acacia_log",
        "dark_oak_log",
        "mangrove_log",
        "cherry_log"
    ];

    let logItem = null;

    for (const name of logs) {
        if (countItem(name) > 0) {
            logItem = name;
            break;
        }
    }

    if (
        logItem &&
        countItem("oak_planks") +
        countItem("birch_planks") +
        countItem("spruce_planks") +
        countItem("jungle_planks") +
        countItem("acacia_planks") +
        countItem("dark_oak_planks") +
        countItem("mangrove_planks") +
        countItem("cherry_planks") === 0
    ) {
        // Let the AI/game crafting system determine the correct
        // recipe if possible.
        const base = logItem.replace("_log", "");
        const planks = `${base}_planks`;

        if (mcData.itemsByName[planks]) {
            messages.push(
                await craftItem(planks, 4)
            );
        }
    }

    // Craft sticks from available planks.
    const plankNames = [
        "oak_planks",
        "birch_planks",
        "spruce_planks",
        "jungle_planks",
        "acacia_planks",
        "dark_oak_planks",
        "mangrove_planks",
        "cherry_planks"
    ];

    let plank = null;

    for (const name of plankNames) {
        if (countItem(name) >= 2) {
            plank = name;
            break;
        }
    }

    if (plank && countItem("stick") < 4) {
        messages.push(
            await craftItem("stick", 2)
        );
    }

    // Craft wooden pickaxe if needed.
    if (
        countItem("wooden_pickaxe") === 0 &&
        countItem("stick") >= 2
    ) {
        messages.push(
            await craftItem("wooden_pickaxe", 1)
        );
    }

    return messages.join(" ");
}

// ============================================================
// COORDINATE PARSER
// ============================================================

function parseCoordinates(text) {
    const match = text.match(
        /(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)/
    );

    if (!match) return null;

    return {
        x: Number(match[1]),
        y: Number(match[2]),
        z: Number(match[3])
    };
}

// ============================================================
// LOCATION MEMORY
// ============================================================

async function rememberLocation(name) {
    if (!name) {
        return "Tell me what to call this location.";
    }

    const position = getCurrentPosition();

    if (!position) {
        return "I don't have a position yet.";
    }

    const cleanName = String(name)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "_")
        .slice(0, 32);

    locations[cleanName] = position;

    saveLocations();

    return `Remembered ${cleanName} at ${position.x}, ${position.y}, ${position.z}.`;
}

async function goToLocation(name) {
    if (!name) {
        return "Tell me which location to go to.";
    }

    const cleanName = String(name)
        .trim()
        .toLowerCase();

    const location = locations[cleanName];

    if (!location) {
        return `I don't remember a location called ${cleanName}.`;
    }

    return await goToCoordinates(
        location.x,
        location.y,
        location.z
    );
}

function listLocations() {
    const names = Object.keys(locations);

    if (names.length === 0) {
        return "I don't remember any locations.";
    }

    return names
        .map(name => {
            const p = locations[name];

            return `${name}: ${p.x}, ${p.y}, ${p.z}`;
        })
        .join(" | ");
}

// ============================================================
// SLEEP
// ============================================================

async function sleep() {
    const bed = bot.findBlock({
        matching: block => {
            if (!block) return false;

            return block.name.endsWith("_bed");
        },
        maxDistance: 32
    });

    if (!bed) {
        return "I can't find a bed nearby.";
    }

    try {
        await bot.sleep(bed);

        // Sleeping in a bed also sets the bot's vanilla respawn
        // point, so this doubles as "set my respawn here".
        return "I'm sleeping.";
    } catch (error) {
        return `I couldn't sleep: ${error.message}`;
    }
}

async function wake() {
    try {
        bot.wake();

        return "I'm awake.";
    } catch (error) {
        return "I couldn't wake up.";
    }
}

// ============================================================
// DOORS
// ============================================================

function isDoor(block) {
    if (!block) return false;

    return (
        block.name.endsWith("_door") ||
        block.name.endsWith("_fence_gate")
    );
}

let doorBusy = false;

async function openNearbyDoor() {
    if (doorBusy || !bot.entity) return;

    const door = bot.findBlock({
        matching: block => isDoor(block),
        maxDistance: 4
    });

    if (!door) return;

    // Only activate if the door appears closed.
    if (
        door.getProperties &&
        door.getProperties().open === true
    ) {
        return;
    }

    doorBusy = true;

    try {
        await bot.lookAt(
            door.position.offset(0.5, 0.5, 0.5),
            true
        );

        await bot.activateBlock(door);

        await bot.waitForTicks(5);
    } catch (error) {
        console.log("Door error:", error.message);
    } finally {
        doorBusy = false;
    }
}

// Detects "stuck against something while trying to path somewhere"
// so we can force a door check even outside the normal timer.
function checkStuck() {
    if (!bot.entity || !bot.pathfinder || !bot.pathfinder.goal) {
        stuckSince = 0;
        lastPosition = null;
        return false;
    }

    const pos = bot.entity.position;

    if (lastPosition && pos.distanceTo(lastPosition) < 0.08) {
        if (!stuckSince) stuckSince = Date.now();
    } else {
        stuckSince = 0;
    }

    lastPosition = pos.clone();

    return !!stuckSince && (Date.now() - stuckSince > 1500);
}

// ============================================================
// CHEST / STORAGE
// ============================================================

async function findNearbyChest() {
    return bot.findBlock({
        matching: block => {
            if (!block) return false;

            return (
                block.name === "chest" ||
                block.name === "trapped_chest"
            );
        },
        maxDistance: 8
    });
}

async function depositItem(itemName, amount = null) {
    const chestBlock = await findNearbyChest();

    if (!chestBlock) {
        return "I can't find a chest nearby.";
    }

    const item = findInventoryItem(itemName);

    if (!item) {
        return `I don't have ${itemName}.`;
    }

    try {
        const chest = await bot.openChest(chestBlock);

        const transferAmount =
            amount == null
                ? item.count
                : Math.min(item.count, Number(amount));

        await chest.deposit(
            item.type,
            item.metadata,
            transferAmount
        );

        chest.close();

        return `I put ${transferAmount} ${itemName} into the chest.`;
    } catch (error) {
        console.log("Chest error:", error.message);
        return `I couldn't put ${itemName} into the chest.`;
    }
}

// ============================================================
// SORT / TIDY INVENTORY
// ============================================================

async function sortInventory() {
    if (!bot.inventory) return "Inventory isn't ready.";

    const items = bot.inventory.items();
    const byType = {};

    for (const item of items) {
        const key = `${item.type}_${item.metadata}`;

        if (!byType[key]) byType[key] = [];

        byType[key].push(item);
    }

    let merges = 0;

    for (const key of Object.keys(byType)) {
        const stacks = byType[key].sort((a, b) => a.slot - b.slot);

        for (let i = 0; i < stacks.length; i++) {
            const target = stacks[i];

            if (!target || target.count >= target.stackSize) continue;

            for (let j = i + 1; j < stacks.length; j++) {
                const source = stacks[j];

                if (!source || source.count <= 0) continue;

                const space = target.stackSize - target.count;

                if (space <= 0) break;

                const moveAmount = Math.min(space, source.count);

                try {
                    await bot.moveSlotItem(source.slot, target.slot);
                    merges++;
                    target.count += moveAmount;
                    source.count -= moveAmount;
                } catch (error) {
                    // A failed move here is non-fatal - just move on.
                }
            }
        }
    }

    return merges > 0
        ? `I tidied up my inventory (merged ${merges} stack${merges === 1 ? "" : "s"}).`
        : "My inventory is already tidy.";
}

// ============================================================
// EQUIP
// ============================================================

async function equipItem(itemName) {
    const item = findInventoryItem(itemName);

    if (!item) {
        return `I don't have ${itemName}.`;
    }

    try {
        await bot.equip(item, "hand");

        return `I equipped ${itemName}.`;
    } catch (error) {
        return `I couldn't equip ${itemName}.`;
    }
}

// ============================================================
// ATTACK
// ============================================================

async function attackTarget(targetName = null) {
    let target = null;

    if (targetName) {
        target = bot.nearestEntity(entity => {
            if (!entity || !entity.position) return false;

            if (entity.name !== targetName) return false;

            return (
                entity.position.distanceTo(
                    bot.entity.position
                ) < 20
            );
        });
    }

    if (!target) {
        target = bot.nearestEntity(entity => {
            return (
                isHostile(entity) &&
                entity.position.distanceTo(
                    bot.entity.position
                ) < 20
            );
        });
    }

    if (!target) {
        return "There is no suitable target nearby.";
    }

    try {
        await equipBestWeapon();
        bot.pvp.attack(target);

        return `I'm attacking the ${target.name}.`;
    } catch (error) {
        return "I couldn't attack that target.";
    }
}

// ============================================================
// BLOCK PLACEMENT
// ============================================================

function findReferenceBlock(position) {
    const offsets = [
        { x: 0, y: -1, z: 0 },
        { x: 1, y: 0, z: 0 },
        { x: -1, y: 0, z: 0 },
        { x: 0, y: 0, z: 1 },
        { x: 0, y: 0, z: -1 },
        { x: 0, y: 1, z: 0 }
    ];

    for (const offset of offsets) {
        const block = bot.blockAt(
            position.offset(
                offset.x,
                offset.y,
                offset.z
            )
        );

        if (
            block &&
            block.name !== "air" &&
            block.name !== "cave_air" &&
            block.name !== "void_air"
        ) {
            return {
                block,
                face: {
                    x: -offset.x,
                    y: -offset.y,
                    z: -offset.z
                }
            };
        }
    }

    return null;
}

async function placeBlockAt(position, itemName) {
    const item = findInventoryItem(itemName);

    if (!item) {
        return false;
    }

    const target = bot.blockAt(position);

    if (
        target &&
        target.name !== "air" &&
        target.name !== "cave_air" &&
        target.name !== "void_air"
    ) {
        return true;
    }

    const reference = findReferenceBlock(position);

    if (!reference) {
        return false;
    }

    try {
        const distance =
            bot.entity.position.distanceTo(position);

        if (distance > 4.5) {
            await bot.pathfinder.goto(
                new goals.GoalNear(
                    position.x,
                    position.y,
                    position.z,
                    3
                )
            );
        }

        await bot.equip(item, "hand");

        await bot.lookAt(
            position.offset(0.5, 0.5, 0.5),
            true
        );

        await bot.placeBlock(
            reference.block,
            new bot.vec3(
                reference.face.x,
                reference.face.y,
                reference.face.z
            )
        );

        return true;
    } catch (error) {
        console.log(
            `Place ${itemName} error:`,
            error.message
        );

        return false;
    }
}

// ============================================================
// STARTER HOUSE
// ============================================================

async function buildStarterHouse() {
    if (!bot.entity) {
        return "I'm not spawned.";
    }

    const origin = bot.entity.position.floored();

    const preferredBlocks = [
        "oak_planks",
        "birch_planks",
        "spruce_planks",
        "cobblestone"
    ];

    let buildingBlock = null;

    for (const name of preferredBlocks) {
        if (countItem(name) >= 20) {
            buildingBlock = name;
            break;
        }
    }

    if (!buildingBlock) {
        return "I need at least 20 building blocks before I can build a house.";
    }

    currentTask = "building starter house";

    let placed = 0;

    const width = 7;
    const depth = 7;
    const wallHeight = 4;

    // --------------------------------------------------------
    // FLOOR
    // --------------------------------------------------------
    // NOTE: this goes one block BELOW the bot's feet (origin.y - 1),
    // not at origin.y (which is where the bot is standing - placing
    // there just fought with the bot's own hitbox and left a gap in
    // the walls at foot level).

    for (let x = 0; x < width; x++) {
        for (let z = 0; z < depth; z++) {
            const position = origin.offset(
                x - 3,
                -1,
                z - 3
            );

            if (
                await placeBlockAt(
                    position,
                    buildingBlock
                )
            ) {
                placed++;
            }
        }
    }

    // --------------------------------------------------------
    // WALLS
    // --------------------------------------------------------
    // Starts at y = 0 (foot level) now, so there's no open gap
    // between the floor and the bottom of the walls.

    for (let y = 0; y <= wallHeight; y++) {
        for (let x = 0; x < width; x++) {
            for (let z = 0; z < depth; z++) {

                const edge =
                    x === 0 ||
                    x === width - 1 ||
                    z === 0 ||
                    z === depth - 1;

                if (!edge) continue;

                // Leave a simple doorway, two blocks tall.
                if (
                    x === Math.floor(width / 2) &&
                    z === 0 &&
                    y <= 1
                ) {
                    continue;
                }

                const position = origin.offset(
                    x - 3,
                    y,
                    z - 3
                );

                if (
                    await placeBlockAt(
                        position,
                        buildingBlock
                    )
                ) {
                    placed++;
                }
            }
        }
    }

    // --------------------------------------------------------
    // ROOF
    // --------------------------------------------------------

    for (let x = -3; x <= 3; x++) {
        for (let z = -3; z <= 3; z++) {
            const position = origin.offset(
                x,
                wallHeight + 1,
                z
            );

            if (
                await placeBlockAt(
                    position,
                    buildingBlock
                )
            ) {
                placed++;
            }
        }
    }

    currentTask = null;

    return `I built a starter house. Placed about ${placed} blocks.`;
}

// ============================================================
// BASIC FARM
// ============================================================

const CROP_MATURITY = {
    wheat: 7,
    carrots: 7,
    potatoes: 7,
    beetroots: 3
};

function isCropMature(block) {
    if (!block) return false;

    const maxAge = CROP_MATURITY[block.name];

    if (maxAge == null) return false;

    const props = block.getProperties ? block.getProperties() : null;

    return props && Number(props.age) >= maxAge;
}

async function findWater() {
    return bot.findBlock({
        matching: block => {
            if (!block) return false;

            return (
                block.name === "water" ||
                block.name === "water_cauldron"
            );
        },
        maxDistance: 32
    });
}

async function farmHere() {
    if (!bot.entity) {
        return "I'm not spawned.";
    }

    const farmland = findBlock("farmland", 32);

    if (!farmland) {
        return "I can't find farmland nearby. Prepare farmland first.";
    }

    const seeds = [
        "wheat_seeds",
        "carrot",
        "potato",
        "beetroot_seeds"
    ];

    const center = farmland.position;

    let harvested = 0;
    let planted = 0;

    for (let dx = -3; dx <= 3; dx++) {
        for (let dz = -3; dz <= 3; dz++) {
            const soil = bot.blockAt(center.offset(dx, 0, dz));

            if (!soil || soil.name !== "farmland") continue;

            const cropPos = center.offset(dx, 1, dz);
            const crop = bot.blockAt(cropPos);

            // Harvest anything that's fully grown.
            if (crop && isCropMature(crop)) {
                try {
                    await bot.dig(crop);
                    harvested++;
                } catch (error) {
                    console.log("Harvest error:", error.message);
                }
            }

            // Replant if the spot is now (or already) empty.
            const afterHarvest = bot.blockAt(cropPos);

            if (afterHarvest && afterHarvest.name === "air") {
                let seedItem = null;

                for (const name of seeds) {
                    seedItem = findInventoryItem(name);
                    if (seedItem) break;
                }

                if (seedItem) {
                    try {
                        if (await placeBlockAt(cropPos, seedItem.name)) {
                            planted++;
                        }
                    } catch {}
                }
            }
        }
    }

    return `I harvested ${harvested} crops and planted ${planted}.`;
}

// ============================================================
// GENERIC RESOURCE GATHERING
// ============================================================

const RESOURCE_ALIASES = {
    wood: "oak_log",
    logs: "oak_log",
    oak: "oak_log",
    stone: "stone",
    cobble: "cobblestone",
    cobblestone: "cobblestone",
    coal: "coal_ore",
    iron: "iron_ore",
    gold: "gold_ore",
    diamond: "diamond_ore",
    redstone: "redstone_ore",
    emerald: "emerald_ore",
    copper: "copper_ore"
};

function normalizeBlockName(name) {
    if (!name) return null;

    let clean = String(name)
        .toLowerCase()
        .trim()
        .replace(/\s+/g, "_");

    if (RESOURCE_ALIASES[clean]) {
        clean = RESOURCE_ALIASES[clean];
    }

    return clean;
}

async function gatherResource(resource, amount = 1) {
    const normalized = normalizeBlockName(resource);

    if (!normalized) {
        return "I don't know which resource you mean.";
    }

    // Wood is special because trees have different log names.
    if (normalized === "oak_log") {
        return await gatherWood(amount);
    }

    return await mineBlock(normalized, amount);
}

// ============================================================
// GET ITEM
// ============================================================

async function getItem(itemName, amount = 1) {
    amount = Math.max(
        1,
        Math.min(Number(amount) || 1, 64)
    );

    const normalized = normalizeBlockName(itemName);

    if (!normalized) {
        return "I don't know what item you want.";
    }

    const current = countItem(normalized);

    if (current >= amount) {
        return `I already have ${current} ${normalized}.`;
    }

    const missing = amount - current;

    return await gatherResource(
        normalized,
        missing
    );
}

// ============================================================
// TASK EXECUTOR
// ============================================================

async function executeStep(step, owner, localTaskId) {
    if (localTaskId !== taskId) {
        return "CANCELLED";
    }

    if (!step || !step.action) {
        return "Invalid task step.";
    }

    const action = String(step.action).toLowerCase();

    console.log("Executing step:", step);

    switch (action) {

        case "follow":
            return await followPlayer(
                step.player || owner
            );

        case "come":
            return await comeToPlayer(owner);

        case "stop":
            return await stopEverything();

        case "protect":
            return await protectPlayer(
                step.player || owner
            );

        case "attack":
            return await attackTarget(
                step.target || null
            );

        case "mine":
            return await mineBlock(
                normalizeBlockName(step.block || step.target),
                Math.min(
                    Number(step.amount) || 1,
                    MAX_MINE_AMOUNT
                )
            );

        case "gather":
            return await gatherResource(
                step.resource || step.target,
                Number(step.amount) || 1
            );

        case "get_item":
            return await getItem(
                step.item || step.target,
                Number(step.amount) || 1
            );

        case "craft":
            return await craftItem(
                step.item || step.target,
                Number(step.amount) || 1
            );

        case "equip":
            return await equipItem(
                step.item || step.target
            );

        case "gear_up":
        case "equip_armor":
            return await gearUp();

        case "cook":
            return await cookFood();

        case "sort_inventory":
        case "sort":
            return await sortInventory();

        case "eat":
            return await eatFood();

        case "sleep":
            return await sleep();

        case "wake":
            return await wake();

        case "goto": {
            if (
                step.x == null ||
                step.y == null ||
                step.z == null
            ) {
                return "Missing coordinates.";
            }

            return await goToCoordinates(
                Number(step.x),
                Number(step.y),
                Number(step.z)
            );
        }

        case "remember":
            return await rememberLocation(
                step.name
            );

        case "goto_location":
            return await goToLocation(
                step.name
            );

        case "list_locations":
            return listLocations();

        case "deposit":
            return await depositItem(
                step.item || step.target,
                step.amount
                    ? Number(step.amount)
                    : null
            );

        case "build_house":
        case "build":
            return await buildStarterHouse();

        case "farm":
        case "harvest":
            return await farmHere();

        case "craft_tools":
            return await craftStarterTools();

        case "chat":
            return step.response || "Okay.";

        default:
            return `I don't know how to perform ${action}.`;
    }
}

// ============================================================
// RUN MULTI-STEP PLAN
// ============================================================

async function executePlan(plan, owner) {
    if (!plan || !Array.isArray(plan.steps)) {
        return "The AI didn't create a valid plan.";
    }

    const steps = plan.steps.slice(0, MAX_PLAN_STEPS);

    taskId++;

    const localTaskId = taskId;

    taskRunning = true;

    currentTask =
        plan.goal ||
        "performing requested task";

    console.log("=================================");
    console.log("TASK START");
    console.log("Goal:", currentTask);
    console.log("Steps:", steps);
    console.log("=================================");

    const results = [];

    try {
        for (let i = 0; i < steps.length; i++) {

            if (localTaskId !== taskId) {
                return "Task cancelled.";
            }

            const step = steps[i];

            const result = await executeStep(
                step,
                owner,
                localTaskId
            );

            console.log(
                `Step ${i + 1}/${steps.length}:`,
                result
            );

            results.push(result);

            if (result === "CANCELLED") {
                return "Task cancelled.";
            }

            // Give Minecraft some breathing room.
            await bot.waitForTicks(5);
        }

        return results[results.length - 1] ||
            "Task completed.";
    } catch (error) {
        console.error("Task error:", error);

        return `I got stuck while doing the task: ${error.message}`;
    } finally {
        if (localTaskId === taskId) {
            taskRunning = false;
            currentTask = null;
        }
    }
}

// ============================================================
// AI BRAIN
// ============================================================

async function askAI(playerName, message) {
    if (!bot.entity) {
        bot.chat("I'm not spawned yet.");
        return;
    }

    if (taskRunning) {
        bot.chat(
            `${playerName}, I'm already doing a task. Say "Kadoo stop" if you want me to cancel it.`
        );
        return;
    }

    try {
        const worldState = getWorldState();

        const prompt = `
You are KadooBot V3, an intelligent Minecraft Java 1.21.8 companion.

You control a real Mineflayer Minecraft bot.

PLAYER:
${playerName}

PLAYER REQUEST:
${message}

CURRENT WORLD STATE:
${worldState}

============================================================
YOUR JOB
============================================================

Understand what the player wants and create a practical
multi-step plan.

You MUST NOT pretend an action happened.

Your job is to decide which Minecraft operations are needed.

The JavaScript bot will execute your plan.

============================================================
AVAILABLE ACTIONS
============================================================

follow
come
stop
protect
attack
mine
gather
get_item
craft
craft_tools
equip
gear_up
cook
sort_inventory
eat
sleep
wake
goto
remember
goto_location
list_locations
deposit
build
build_house
farm
harvest
chat

============================================================
ACTION FORMAT
============================================================

Every step must look like:

{
  "action": "action_name",
  "...": "parameters"
}

Examples:

FOLLOW:

{
  "action": "follow",
  "player": "${playerName}"
}

COME:

{
  "action": "come"
}

PROTECT:

{
  "action": "protect",
  "player": "${playerName}"
}

MINE:

{
  "action": "mine",
  "block": "iron_ore",
  "amount": 10
}

GATHER:

{
  "action": "gather",
  "resource": "wood",
  "amount": 10
}

CRAFT:

{
  "action": "craft",
  "item": "stone_pickaxe",
  "amount": 1
}

GEAR UP (equip best armor/weapon/shield it's carrying):

{
  "action": "gear_up"
}

COOK (needs a furnace nearby, raw food and fuel in inventory):

{
  "action": "cook"
}

SORT INVENTORY (merge partial item stacks):

{
  "action": "sort_inventory"
}

GOTO:

{
  "action": "goto",
  "x": 100,
  "y": 64,
  "z": -200
}

REMEMBER:

{
  "action": "remember",
  "name": "home"
}

GO TO MEMORY:

{
  "action": "goto_location",
  "name": "home"
}

BUILD:

{
  "action": "build_house"
}

FARM / HARVEST (also harvests grown crops and replants):

{
  "action": "farm"
}

SLEEP:

{
  "action": "sleep"
}

DEPOSIT:

{
  "action": "deposit",
  "item": "iron_ingot",
  "amount": 20
}

============================================================
IMPORTANT PLANNING RULES
============================================================

1. Think in multiple steps.

For example:

"get me 20 iron"

should NOT simply be:

mine iron

Instead consider:

- Check whether the bot already has iron.
- Obtain/craft appropriate tools if possible.
- Mine iron ore.
- If there is no iron nearby, explain the limitation.

Another example:

"get wood and make a pickaxe"

should become something like:

gather wood
craft tools

Another:

"build me a house"

should consider:
- whether the bot has building materials
- building the starter house

2. Never invent resources.

The current inventory is shown above.

3. Never claim that something is completed before the
JavaScript executor actually performs the step.

4. If the request is impossible with the currently available
skills, explain that briefly.

5. For coordinates, use the exact numbers supplied by the player.

6. If the player says "here", use the bot's current position.

7. If the player says "home", "base", "mine", etc., use the
memorized location if it exists. If the player asks to set a
home/respawn point, use "remember" with name "home".

8. Keep the final response short because it will appear in
Minecraft chat.

9. Use no more than 20 steps.

10. Do not generate JavaScript.

11. Do not generate Markdown.

12. Return ONLY valid JSON.

============================================================
OUTPUT FORMAT
============================================================

{
  "goal": "short description",
  "steps": [
    {
      "action": "..."
    }
  ],
  "response": "short response"
}

============================================================
EXAMPLES
============================================================

Request:
"follow me"

Output:

{
  "goal": "follow player",
  "steps": [
    {
      "action": "follow",
      "player": "${playerName}"
    }
  ],
  "response": "I'm following you."
}

Request:
"protect me"

Output:

{
  "goal": "protect player",
  "steps": [
    {
      "action": "protect",
      "player": "${playerName}"
    }
  ],
  "response": "I'll protect you."
}

Request:
"go to 100 64 -200"

Output:

{
  "goal": "go to coordinates",
  "steps": [
    {
      "action": "goto",
      "x": 100,
      "y": 64,
      "z": -200
    }
  ],
  "response": "I'm going there."
}

Request:
"remember this as home"

Output:

{
  "goal": "remember current location",
  "steps": [
    {
      "action": "remember",
      "name": "home"
    }
  ],
  "response": "I'll remember this as home."
}

Request:
"go home"

Output:

{
  "goal": "go home",
  "steps": [
    {
      "action": "goto_location",
      "name": "home"
    }
  ],
  "response": "I'm going home."
}

Request:
"build me a house"

Output:

{
  "goal": "build starter house",
  "steps": [
    {
      "action": "build_house"
    }
  ],
  "response": "I'll build you a house."
}

Request:
"get me 20 iron"

Output:

{
  "goal": "get iron",
  "steps": [
    {
      "action": "gather",
      "resource": "iron",
      "amount": 20
    }
  ],
  "response": "I'll get the iron."
}

Request:
"make me tools"

Output:

{
  "goal": "craft tools",
  "steps": [
    {
      "action": "craft_tools"
    }
  ],
  "response": "I'll make some tools."
}

Request:
"gear up"

Output:

{
  "goal": "equip gear",
  "steps": [
    {
      "action": "gear_up"
    }
  ],
  "response": "Gearing up."
}

============================================================
FINAL RULE
============================================================

Do not confuse planning with execution.

The JavaScript program executes the steps.
`;

        console.log("Sending request to Gemini...");

        const result = await ai.models.generateContent({
            model: MODEL,
            contents: prompt
        });

        let text = result.text.trim();

        // Remove code fences if Gemini adds them.
        text = text
            .replace(/^```json/i, "")
            .replace(/^```/i, "")
            .replace(/```$/i, "")
            .trim();

        console.log("AI:", text);

        let plan;

        try {
            plan = JSON.parse(text);
        } catch (error) {
            console.log("AI JSON parse error:", error);

            bot.chat(
                "I understood you, but my planning output was invalid."
            );

            return;
        }

        if (
            !plan ||
            !Array.isArray(plan.steps)
        ) {
            bot.chat("I couldn't create a valid plan.");
            return;
        }

        // Tell player what Kadoo is doing.
        if (plan.response) {
            bot.chat(
                String(plan.response).slice(0, 250)
            );
        }

        // Execute actual Minecraft operations.
        const resultMessage = await executePlan(
            plan,
            playerName
        );

        console.log(
            "TASK RESULT:",
            resultMessage
        );

        // Only send another message if useful.
        if (
            resultMessage &&
            resultMessage !== plan.response &&
            resultMessage !== "Okay."
        ) {
            bot.chat(
                String(resultMessage).slice(0, 250)
            );
        }

    } catch (error) {
        console.error("AI ERROR:", error);

        bot.chat(
            "My AI brain is having trouble right now."
        );
    }
}

// ============================================================
// PHYSICS LOOP
// ============================================================

bot.on("physicsTick", () => {
    if (!bot.entity) return;

    // --------------------------------------------------------
    // FOLLOW
    // --------------------------------------------------------

    if (followingPlayer && !taskRunning) {
        const player = bot.players[followingPlayer];

        if (player && player.entity) {
            bot.pathfinder.setGoal(
                new goals.GoalFollow(
                    player.entity,
                    2
                ),
                true
            );
        }
    }

    // --------------------------------------------------------
    // PROTECTION
    // --------------------------------------------------------

    const now = Date.now();

    if (
        protectingPlayer &&
        now - lastProtectionCheck > 500
    ) {
        lastProtectionCheck = now;

        protectTick().catch(error => {
            console.log(
                "Protection error:",
                error.message
            );
        });
    }

    // --------------------------------------------------------
    // SELF-DEFENSE (always on, not just while protecting someone)
    // --------------------------------------------------------

    if (now - lastSelfDefenseCheck > 600) {
        lastSelfDefenseCheck = now;

        selfDefenseTick().catch(error => {
            console.log(
                "Self-defense error:",
                error.message
            );
        });
    }

    // --------------------------------------------------------
    // SURVIVAL (eating/retreating - now runs during tasks too)
    // --------------------------------------------------------

    if (
        now - lastSurvivalCheck > 3000
    ) {
        lastSurvivalCheck = now;

        survivalCheck().catch(error => {
            console.log(
                "Survival error:",
                error.message
            );
        });
    }

    // --------------------------------------------------------
    // GEAR (periodically put on any better armor picked up)
    // --------------------------------------------------------

    if (now - lastGearCheck > 15000) {
        lastGearCheck = now;

        equipArmor().catch(error => {
            console.log("Gear check error:", error.message);
        });
    }

    // --------------------------------------------------------
    // DOORS
    // --------------------------------------------------------

    const stuck = checkStuck();

    if (now - lastDoorCheck > 400 || stuck) {
        lastDoorCheck = now;

        openNearbyDoor().catch(() => {});
    }
});

// ============================================================
// ENTITY ATTACK DETECTION
// ============================================================

bot.on("entityHurt", entity => {
    if (!entity) return;

    // If Kadoo itself is attacked, defend itself regardless of
    // whether it's currently in "protect" mode.
    if (entity === bot.entity) {
        const attacker = bot.nearestEntity(target => {
            if (!isHostile(target)) return false;

            return (
                target.position.distanceTo(
                    bot.entity.position
                ) < 12
            );
        });

        if (attacker) {
            equipBestWeapon()
                .catch(() => {})
                .finally(() => {
                    try {
                        bot.pvp.attack(attacker);
                    } catch {}
                });
        }
    }
});

// ============================================================
// DEATH / RESPAWN
// ============================================================

bot.on("death", () => {
    console.log("Bot died.");

    stopEverything();

    // Give the server a few seconds to actually respawn the bot
    // (at its bed spawn if one was set by sleeping, otherwise the
    // world spawn) before trying anything.
    setTimeout(async () => {
        try {
            bot.chat("I respawned.");

            await equipArmor();

            if (locations.home) {
                bot.chat("Heading back to base.");
                await goToLocation("home");
            }
        } catch (error) {
            console.log("Respawn handling error:", error.message);
        }
    }, 3000);
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

// ============================================================
// UNHANDLED ERRORS
// ============================================================

process.on("unhandledRejection", error => {
    console.error(
        "Unhandled promise rejection:",
        error
    );
});

process.on("uncaughtException", error => {
    console.error(
        "Uncaught exception:",
        error
    );
});
