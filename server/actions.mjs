// Hard allowlist. Whatever Claude proposes, only these action shapes can ever reach the server,
// and every command string is built here from validated values (never from free text).
export const SPAWN = { x: 97.5, y: 71, z: 1234.5 }; // world spawn from level.dat
const TIMES = { day: "day", noon: "noon", night: "night", midnight: "midnight", sunrise: "sunrise" };
const WEATHER = { clear: "clear", rain: "rain", thunder: "thunder" };
export const EFFECTS = ["speed", "jump_boost", "night_vision", "glowing", "slow_falling", "water_breathing", "luck", "regeneration", "haste", "fire_resistance"];
const SOUNDS = {
  cheer: "minecraft:ui.toast.challenge_complete",
  levelup: "minecraft:entity.player.levelup",
  bell: "minecraft:block.bell.use",
  horn: "minecraft:event.raid.horn",
  thunder: "minecraft:entity.lightning_bolt.thunder",
  firework: "minecraft:entity.firework_rocket.twinkle",
};
const COLORS = ["white", "yellow", "gold", "aqua", "green", "light_purple", "red", "blue"];
const MAX_ACTIONS = 5;

const cleanText = (s, n) => String(s ?? "").replace(/[§\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

export function validateActions(actions, online) {
  const ok = [], rejected = [];
  const onlineSet = new Map(online.map((p) => [p.toLowerCase(), p]));
  const player = (p) => onlineSet.get(String(p ?? "").toLowerCase());
  const target = (t) => (t === "@a" || t === "everyone" ? "@a" : player(t));
  const list = Array.isArray(actions) ? actions : [];
  for (const a of list) {
    const why = (reason) => rejected.push({ action: a, reason });
    if (ok.length >= MAX_ACTIONS) { why("too many actions (max 5)"); continue; }
    switch (a?.type) {
      case "time":
        if (!TIMES[a.value]) { why("unknown time"); break; }
        ok.push({ type: "time", value: a.value }); break;
      case "weather":
        if (!WEATHER[a.value]) { why("unknown weather"); break; }
        ok.push({ type: "weather", value: a.value, seconds: Math.min(Math.max(+a.seconds || 600, 60), 1800) }); break;
      case "announce": {
        const text = cleanText(a.text, 120);
        if (!text) { why("empty announcement"); break; }
        ok.push({ type: "announce", text, style: a.style === "title" ? "title" : "chat", color: COLORS.includes(a.color) ? a.color : "gold" }); break;
      }
      case "sound":
        if (!SOUNDS[a.sound]) { why("sound not allowed"); break; }
        ok.push({ type: "sound", sound: a.sound }); break;
      case "effect": {
        const t = target(a.target);
        if (!t) { why("target must be an online player or everyone"); break; }
        if (!EFFECTS.includes(a.effect)) { why("effect not allowed"); break; }
        ok.push({ type: "effect", target: t, effect: a.effect, seconds: Math.min(Math.max(+a.seconds || 30, 5), 60), amplifier: Math.min(Math.max(+a.amplifier || 0, 0), 1) }); break;
      }
      case "tp_to_player": {
        const p = player(a.player), t = player(a.target);
        if (!p || !t) { why("both players must be online"); break; }
        if (p === t) { why("same player"); break; }
        ok.push({ type: "tp_to_player", player: p, target: t }); break;
      }
      case "tp_spawn": {
        const p = target(a.player);
        if (!p) { why("player must be online"); break; }
        ok.push({ type: "tp_spawn", player: p }); break;
      }
      default:
        why("action type not allowed");
    }
  }
  return { ok, rejected };
}

const json = (o) => JSON.stringify(o);
export function toCommands(actions) {
  const out = [];
  for (const a of actions) {
    switch (a.type) {
      case "time": out.push({ command: `time set ${a.value === "sunrise" ? 23000 : a.value}`, label: `time → ${a.value}` }); break;
      case "weather": out.push({ command: `weather ${WEATHER[a.value]} ${a.seconds}s`, label: `weather → ${a.value} (${a.seconds}s)` }); break;
      case "announce":
        if (a.style === "title") {
          out.push({ command: `title @a times 10 70 20`, label: null });
          out.push({ command: `title @a title ${json({ text: a.text.slice(0, 40), color: a.color, bold: true })}`, label: `title: “${a.text}”` });
          if (a.text.length > 40) out.push({ command: `title @a subtitle ${json({ text: a.text.slice(40), color: "white" })}`, label: null });
        } else out.push({ command: `tellraw @a ${json([{ text: "[DAWORLD] ", color: "dark_aqua", bold: true }, { text: a.text, color: a.color }])}`, label: `announce: “${a.text}”` });
        break;
      case "sound": out.push({ command: `execute as @a at @s run playsound ${SOUNDS[a.sound]} master @s ~ ~ ~ 1 1`, label: `sound: ${a.sound}` }); break;
      case "effect": out.push({ command: `effect give ${a.target} minecraft:${a.effect} ${a.seconds} ${a.amplifier} true`, label: `${a.effect}${a.amplifier ? " II" : ""} ${a.seconds}s → ${a.target === "@a" ? "everyone" : a.target}` }); break;
      case "tp_to_player": out.push({ command: `tp ${a.player} ${a.target}`, label: `tp ${a.player} → ${a.target}` }); break;
      case "tp_spawn":
        out.push({ command: `execute in minecraft:overworld run tp ${a.player} ${SPAWN.x} ${SPAWN.y} ${SPAWN.z}`, label: `tp ${a.player === "@a" ? "everyone" : a.player} → spawn` });
        break;
    }
  }
  return out;
}
