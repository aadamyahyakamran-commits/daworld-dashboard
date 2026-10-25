// Backend safety net for mod/admin requests. Claude decides "advantage to one player or not";
// this file blocks the few things that must never run no matter what Claude says.
const MAX_COMMANDS = 10;
const OWNER = (process.env.OWNER || "EzioFlame").toLowerCase();

// never allowed
const BLOCKED_ROOTS = {
  op: "giving op is owner-only", deop: "op changes are owner-only",
  stop: "stopping the server isn't allowed from the dashboard", restart: "restarting isn't allowed from the dashboard",
  reload: "reload breaks plugins on this server", "save-off": "turning saving off isn't allowed",
  data: "data commands can expose the treasure hunt", locate: "locate can expose the treasure hunt",
  function: "datapack functions are owner-only", datapack: "datapack changes are owner-only", schedule: "scheduled functions are owner-only",
  forceload: "forceload is owner-only", place: "structure placing is owner-only", "ban-ip": "IP bans are owner-only",
  orbital: "orbital cannons are command-only and owner-only", geyser: "plugin admin is owner-only", fwhitelist: "use whitelist instead",
  plugins: "", pl: "", setidletimeout: "", "transfer": "transfers are owner-only", debug: "", perf: "", jfr: "",
};
// these hand out stuff: only allowed if everyone gets the same thing
const ADVANTAGE_ROOTS = new Set(["give", "item", "loot", "enchant", "xp", "experience", "attribute", "effect", "recipe"]);
const SECRET = /hunt[_:]|tag=hunt|lodestone_tracker|\btrial_key\b|\bvault\b|\bmarker\b|custom_data|\borbital\b|\bnuke_|\bstab_|seeker_compass/i;
const NAME_IN = (s) => new RegExp(`(^|[\\s@\\[=,"])${OWNER}($|[\\s\\],"])`, "i").test(s);

function checkOne(cmd, depth = 0) {
  if (!cmd) return "empty command";
  if (/[\r\n§]/.test(cmd)) return "multi-line or formatting codes";
  if (cmd.length > 300) return "too long";
  if (SECRET.test(cmd)) return "touches the treasure hunt or orbital cannons";
  const parts = cmd.trim().split(/\s+/);
  const root = parts[0].toLowerCase().replace(/^minecraft:/, "");
  if (root === "execute") {
    // only "execute in <dimension> run <command>" (e.g. Nether world border)
    const m = /^execute in (minecraft:)?(overworld|the_nether|the_end) run (.+)$/i.exec(cmd.trim());
    if (!m || depth) return "only `execute in <dimension> run …` is allowed";
    return checkOne(m[3], 1) || null;
  }
  if (root in BLOCKED_ROOTS) return BLOCKED_ROOTS[root] || "not allowed";
  // owner protection
  if (["ban", "kick", "kill", "clear", "gamemode", "effect", "tp", "teleport", "spreadplayers", "damage", "ride", "spectate", "attribute"].includes(root) && !(root === "tp" || root === "teleport") && NAME_IN(cmd))
    return "can't target the owner";
  if ((root === "tp" || root === "teleport") && parts[1] && NAME_IN(parts[1])) return "can't move the owner";
  // everyone-equal rule for item/effect handouts
  if (ADVANTAGE_ROOTS.has(root)) {
    const target = root === "item" ? parts[3] : root === "loot" ? parts[2] : root === "recipe" ? parts[2] : parts[1] === "give" || parts[1] === "add" || parts[1] === "set" ? parts[2] : parts[1];
    if (root === "effect" && parts[1] === "clear") { /* removing effects is fine */ }
    else if (target !== "@a") return "handing out items/effects/XP must target everyone (@a), not one player";
  }
  if (root === "gamemode" && /creative/i.test(parts[1] || "")) return "creative mode is an advantage";
  if (root === "clear" && parts.length < 3) return "clear must name an item (no full inventory wipes)";
  if (root === "kill" && /type=!/i.test(cmd)) return "kill with a negated type= would wipe hunt markers";
  if (root === "kill" && /@e(?!\[[^\]]*type=(?!minecraft:marker\b|marker\b))/i.test(cmd)) return "kill @e needs a type= (and never markers)";
  if (root === "worldborder" && depth === 0) {
    // overworld border can't shrink below ±10,000 or move (keeps the treasure hunt solvable)
    if (parts[1] === "center") return "the overworld border centre can't move";
    if (parts[1] === "set" && +parts[2] < 20000) return "overworld border can't go below ±10,000";
    if (parts[1] === "add" && +parts[2] < 0) return "overworld border can't shrink";
  }
  return null;
}

export function checkCommands(list) {
  const ok = [], rejected = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const cmd = String(raw ?? "").trim().replace(/^\//, "");
    if (ok.length >= MAX_COMMANDS) { rejected.push({ command: cmd, reason: "too many commands (max 10)" }); continue; }
    // execute-in-overworld worldborder still gets the overworld limits
    const m = /^execute in (minecraft:)?overworld run (worldborder .+)$/i.exec(cmd);
    const why = m ? checkOne(m[2]) : checkOne(cmd);
    if (why) rejected.push({ command: cmd, reason: why }); else ok.push(cmd);
  }
  return { ok, rejected };
}
