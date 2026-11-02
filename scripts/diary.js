/**
 * Diario de la sesión (pestaña Notas): lo que le pasó al personaje (o a un compañero) en la sesión actual.
 * Nada se escribe a mano: cada entrada sale de un mensaje del chat (tiradas y usos de dnd5e), del hook de dnd5e
 * que avisa de daño y curación (`dnd5e.damageActor` / `dnd5e.healActor`) o de un efecto que se pone o se quita.
 *
 * Se guarda en este teléfono (localStorage), por actor. "Sesión actual": si pasan más de 6 horas sin nada nuevo,
 * empieza una sesión nueva; también se puede limpiar a mano. Al abrir la vista se recuperan del chat las tiradas
 * de la sesión que aún no estaban (p. ej. después de recargar la página).
 */

const STORE_PREFIX = "bhd-companion.diary.";

/** Horas sin entradas tras las que empieza una sesión nueva. */
const SESSION_GAP_MS = 6 * 60 * 60 * 1000;

/** Entradas máximas por actor. */
const MAX_ENTRIES = 300;

/** Filtros de la lista: qué categorías enseña cada uno. */
export const DIARY_FILTERS = ["all", "rolls", "combat"];

/** Tipos de tirada de dnd5e que cuentan también como "Combate". */
const COMBAT_ROLLS = new Set(["attack", "damage", "death", "initiative", "healing"]);

/* -------------------------------------------- */
/*  Almacén                                     */
/* -------------------------------------------- */

/**
 * @param {Actor} actor
 * @returns {{start: number, last: number, entries: object[]}}
 */
function load(actor) {
  const now = Date.now();
  let data = null;
  try {
    data = JSON.parse(localStorage.getItem(STORE_PREFIX + actor.uuid) ?? "null");
  } catch(err) {}
  if ( !data || !Array.isArray(data.entries) || ((now - (data.last ?? 0)) > SESSION_GAP_MS) ) {
    data = { start: now - SESSION_GAP_MS, last: now, entries: [], backfilled: false };
  }
  return data;
}

/**
 * @param {Actor} actor
 * @param {object} data
 */
function save(actor, data) {
  try {
    localStorage.setItem(STORE_PREFIX + actor.uuid, JSON.stringify(data));
  } catch(err) {
    console.warn("BHD Companion | Diario: no se pudo guardar en este teléfono", err);
  }
}

/**
 * Añade una entrada (si no estaba ya).
 * @param {Actor} actor
 * @param {{id: string, time: number, icon: string, text: string, total?: string|number, tags: string[]}} entry
 * @returns {boolean}  true si se añadió.
 */
function add(actor, entry) {
  const data = load(actor);
  if ( data.entries.some(e => e.id === entry.id) ) return false;
  if ( entry.time < data.start ) return false;
  data.entries.push(entry);
  data.entries.sort((a, b) => a.time - b.time);
  if ( data.entries.length > MAX_ENTRIES ) data.entries.splice(0, data.entries.length - MAX_ENTRIES);
  data.last = Math.max(data.last ?? 0, entry.time);
  save(actor, data);
  return true;
}

/**
 * Vacía el diario del actor: la sesión empieza ahora.
 * @param {Actor} actor
 */
export function clearDiary(actor) {
  const now = Date.now();
  save(actor, { start: now, last: now, entries: [], backfilled: true });
}

/* -------------------------------------------- */
/*  Entradas                                    */
/* -------------------------------------------- */

/**
 * ¿El mensaje habla como este actor? (Una ficha no vinculada: solo su ficha.)
 * @param {ChatMessage} message
 * @param {Actor} actor
 */
function speaksAs(message, actor) {
  const speaker = message.speaker ?? {};
  if ( speaker.actor !== actor.id ) return false;
  return !actor.isToken || (speaker.token === actor.token?.id);
}

/**
 * Tipo de tirada de dnd5e: `flags.dnd5e.roll.type` (dnd5e 5) o el tipo del mensaje (dnd5e 6).
 * @param {ChatMessage} message
 * @returns {string|null}
 */
function getRollType(message) {
  const legacy = message.flags?.dnd5e?.roll?.type;
  if ( legacy ) return legacy;
  const system = message.system ?? {};
  switch ( message.type ) {
    case "save": return (system.type === "death") ? "death" : ((system.type === "concentration") ? "concentration" : "save");
    case "check":
      if ( system.type === "initiative" ) return "initiative";
      return system.tool ? "tool" : (system.skill ? "skill" : "ability");
    case "attack":
    case "damage":
    case "healing": return message.type;
  }
  return message.rolls?.length ? "roll" : null;
}

/**
 * ¿Es la tarjeta de usar un objeto o actividad de dnd5e?
 * @param {ChatMessage} message
 */
function isUsageCard(message) {
  return (message.type === "usage") || (message.flags?.dnd5e?.messageType === "usage");
}

/**
 * Texto plano de un trozo de HTML.
 * @param {string} html
 */
function textOf(html) {
  const template = document.createElement("template");
  template.innerHTML = String(html ?? "");
  return template.content.textContent.replace(/\s+/g, " ").trim();
}

/**
 * Entrada del diario para un mensaje del chat, o null si no es del actor o no es una tirada / un uso.
 * Las tiradas que el jugador no puede ver (ciegas, del DM) no entran.
 * @param {ChatMessage} message
 * @param {Actor} actor
 * @returns {object|null}
 */
function entryFromMessage(message, actor) {
  if ( !speaksAs(message, actor) || !message.visible ) return null;
  if ( isUsageCard(message) ) {
    const item = message.getAssociatedItem?.() ?? null;
    const name = item?.name ?? (textOf(message.flavor) || null);
    if ( !name ) return null;
    return {
      id: message.id, time: message.timestamp, icon: "fa-solid fa-hand-sparkles",
      text: game.i18n.format("BHD.Diary.Used", { name }), tags: ["combat"]
    };
  }
  if ( !message.rolls?.length || (message.isRoll && !message.isContentVisible) ) return null;
  const type = getRollType(message);
  if ( !type ) return null;
  const total = message.rolls.reduce((sum, roll) => sum + (Number(roll.total) || 0), 0);
  const typeKey = game.i18n.has(`BHD.Diary.Roll.${type}`) ? `BHD.Diary.Roll.${type}` : "BHD.Diary.Roll.roll";
  const label = textOf(message.flavor) || game.i18n.localize(typeKey);
  const tags = ["rolls"];
  if ( COMBAT_ROLLS.has(type) ) tags.push("combat");
  const roll = message.rolls[0];
  const extra = roll?.isCritical ? " ★" : (roll?.isFumble ? " ✗" : "");
  return {
    id: message.id, time: message.timestamp, icon: "fa-solid fa-dice-d20",
    text: label, total: `${total}${extra}`, tags
  };
}

/**
 * Un mensaje nuevo del chat: lo apunta en el diario de cada actor del jugador al que corresponda.
 * @param {ChatMessage} message
 * @param {Actor[]} actors
 * @returns {boolean}  true si se apuntó algo.
 */
export function recordMessage(message, actors) {
  let added = false;
  for ( const actor of actors ) {
    const entry = entryFromMessage(message, actor);
    if ( entry && add(actor, entry) ) added = true;
  }
  return added;
}

/**
 * Daño o curación (hooks `dnd5e.damageActor` / `dnd5e.healActor`).
 * @param {Actor} actor
 * @param {{hp: number, temp: number, total: number}} changes
 * @returns {boolean}
 */
export function recordHitPoints(actor, changes) {
  const amount = Math.abs(changes.total);
  if ( !amount ) return false;
  const damage = changes.total < 0;
  return add(actor, {
    id: foundry.utils.randomID(), time: Date.now(),
    icon: damage ? "fa-solid fa-heart-crack" : "fa-solid fa-heart-pulse",
    text: game.i18n.format(damage ? "BHD.Diary.Damage" : "BHD.Diary.Healed", { amount }),
    total: `${damage ? "−" : "+"}${amount}`,
    tags: ["combat"],
    kind: damage ? "damage" : "heal"
  });
}

/**
 * Un efecto se puso o se quitó: condiciones (estados de dnd5e) y efectos temporales (Bendición...).
 * @param {ActiveEffect} effect
 * @param {boolean} gained
 * @returns {boolean}
 */
export function recordEffect(effect, gained) {
  const actor = (effect.parent instanceof Actor) ? effect.parent : null;
  if ( !actor || !(effect.statuses?.size || effect.isTemporary) ) return false;
  const isCondition = !!effect.statuses?.size;
  const key = isCondition ? (gained ? "BHD.Diary.ConditionGained" : "BHD.Diary.ConditionLost")
    : (gained ? "BHD.Diary.EffectGained" : "BHD.Diary.EffectLost");
  return add(actor, {
    id: foundry.utils.randomID(), time: Date.now(),
    icon: isCondition ? "fa-solid fa-person-falling" : "fa-solid fa-wand-magic-sparkles",
    text: game.i18n.format(key, { name: effect.name }),
    tags: ["combat"]
  });
}

/**
 * Recupera del chat las tiradas y usos de la sesión que aún no estaban (una vez por sesión y actor).
 * @param {Actor} actor
 */
export function backfillDiary(actor) {
  const data = load(actor);
  if ( data.backfilled ) return;
  data.backfilled = true;
  save(actor, data);
  let count = 0;
  for ( const message of game.messages ) {
    if ( message.timestamp < data.start ) continue;
    const entry = entryFromMessage(message, actor);
    if ( entry && add(actor, entry) ) count++;
  }
  if ( count ) console.log(`BHD Companion | Diario: ${count} entradas recuperadas del chat para ${actor.name}`);
}

/* -------------------------------------------- */

/**
 * Datos de la sección Diario.
 * @param {Actor} actor
 * @param {string} filter  "all", "rolls" o "combat".
 * @returns {object}
 */
export function prepareDiary(actor, filter) {
  backfillDiary(actor);
  const { entries } = load(actor);
  const timeFormat = new Intl.DateTimeFormat(game.i18n.lang, { hour: "2-digit", minute: "2-digit" });
  const shown = entries
    .filter(e => (filter === "all") || e.tags?.includes(filter))
    .reverse()
    .map(e => ({ ...e, timeLabel: timeFormat.format(new Date(e.time)) }));
  return {
    entries: shown,
    count: entries.length,
    filters: DIARY_FILTERS.map(id => ({
      id, label: game.i18n.localize(`BHD.Diary.Filter.${id}`), active: id === filter
    }))
  };
}
