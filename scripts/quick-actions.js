/**
 * Botones de tirada de cada fila (estilo D&D Beyond): Ataque, Daño, Salvación, Curar o Usar.
 *
 * Cada botón hace una sola cosa con las funciones de dnd5e, sin ventanas:
 * - Ataque → `activity.rollAttack` (solo la tirada de ataque).
 * - Daño / Curar → `activity.rollDamage` (solo esa tirada; crítico si el último ataque fue un 20 natural).
 * - Salvación / Usar → `activity.use` (la tarjeta del chat con la CD, para que el DM tire por los objetivos).
 *
 * "Lanzamiento": lo que gasta algo (espacio de conjuro, usos, cantidad, concentración) se hace con
 * `activity.use` una sola vez, al tocar el primer botón. La tarjeta que crea es el "lanzamiento" y las
 * tiradas siguientes cuelgan de ella (`originatingMessage`, nivel del espacio para el daño). En hechizos el
 * lanzamiento dura hasta que cambia el turno (o 2 minutos fuera de combate), así se pueden tirar varios
 * ataques del mismo hechizo; en rasgos y consumibles termina con la tirada de daño o curación.
 */

/** Cuánto dura un lanzamiento de hechizo fuera de combate (ms). */
const CAST_TTL = 2 * 60 * 1000;

/**
 * Tipos de actividad que se usan sin la ventana de dnd5e. Los demás (invocar, encantar, transformar...)
 * tienen opciones que solo se eligen en su ventana.
 */
const QUICK_TYPES = new Set(["attack", "damage", "heal", "save", "check", "utility"]);

/**
 * Estado de los botones de tirada en este teléfono: nivel de espacio elegido, lanzamientos en curso
 * y último ataque de cada actividad (para el crítico).
 */
export class QuickActionState {

  /**
   * Espacio de conjuro elegido en el selector de cada hechizo ("spell2", "pact"...).
   * @type {Map<string, string>}
   */
  slots = new Map();

  /**
   * Lanzamientos en curso, por objeto.
   * @type {Map<string, {activityId: string, slot: string|null, scaling: number, messageId: string|null,
   *   time: number, turnKey: string|null, sticky: boolean}>}
   */
  casts = new Map();

  /**
   * Último ataque de cada actividad ("itemId.activityId"): crítico, munición y modo (a una mano...).
   * @type {Map<string, {critical: boolean, ammunition: string|null, attackMode: string|null}>}
   */
  attacks = new Map();

  /**
   * Lanzamiento en curso de un objeto, si sigue valiendo.
   * @param {Item} item
   * @returns {object|null}
   */
  getCast(item) {
    const cast = this.casts.get(item.id);
    if ( !cast ) return null;
    const messageGone = cast.messageId && !game.messages.has(cast.messageId);
    const expired = cast.turnKey ? (cast.turnKey !== getTurnKey()) : (Date.now() - cast.time > CAST_TTL);
    if ( messageGone || expired ) {
      this.casts.delete(item.id);
      return null;
    }
    return cast;
  }

  /**
   * Espacio de conjuro que se usará para esta actividad: el del lanzamiento en curso, el elegido en
   * el selector (si sigue teniendo usos) o el que dnd5e propone.
   * @param {Activity} activity
   * @returns {string|null}
   */
  getSlot(activity) {
    const options = getSlotOptions(activity);
    if ( !options ) return null;
    const cast = this.getCast(activity.item);
    if ( cast?.slot ) return cast.slot;
    const chosen = this.slots.get(activity.item.id);
    if ( options.some(o => (o.value === chosen) && !o.disabled) ) return chosen;
    return options.find(o => o.default && !o.disabled)?.value
      ?? options.find(o => !o.disabled)?.value
      ?? options[0]?.value ?? null;
  }

  /**
   * @param {Activity} activity
   * @returns {object|null}
   */
  getLastAttack(activity) {
    return this.attacks.get(`${activity.item.id}.${activity.id}`) ?? null;
  }
}

/* -------------------------------------------- */

/**
 * Clave del turno actual del combate activo (o null fuera de combate).
 * @returns {string|null}
 */
export function getTurnKey() {
  const combat = game.combats.find(c => c.active && c.started && (!c.scene || (c.scene === game.scenes.active)))
    ?? game.combats.find(c => c.active && c.started);
  return combat ? `${combat.id}.${combat.round}.${combat.turn}` : null;
}

/**
 * Actividades que dan botón en la fila.
 * @param {Item} item
 * @param {Activity[]} activities  Actividades que se pueden usar (en el HUD, las del bloque).
 * @returns {{attack: Activity|null, save: Activity|null, damage: Activity|null, heal: Activity|null,
 *   use: Activity|null, primary: Activity|null}}
 */
export function getRowActivities(item, activities) {
  const pick = type => activities.find(a => a.type === type) ?? null;
  const attack = pick("attack");
  const save = pick("save");
  const heal = pick("heal");
  const hasDamage = a => !!a?.damage?.parts?.length;
  let damage = [attack, save, pick("damage")].find(hasDamage) ?? null;
  // Hondas, arcos...: el daño puede venir solo de la munición.
  if ( !damage && attack && item.system.properties?.has("amm") ) damage = attack;
  const use = (attack || save || damage || heal) ? null : (activities[0] ?? null);
  return { attack, save, damage, heal, use, primary: attack ?? save ?? damage ?? heal ?? use };
}

/**
 * Opciones del selector de nivel de un hechizo, con las mismas reglas que la ventana de uso de dnd5e.
 * Null si la actividad no gasta espacio o no puede subir de nivel.
 * @param {Activity} activity
 * @returns {{value: string, label: string, level: number, disabled: boolean, default: boolean}[]|null}
 */
export function getSlotOptions(activity) {
  if ( !activity?.requiresSpellSlot || !activity.consumption?.spellSlot ) return null;
  const item = activity.item;
  const actor = activity.actor;
  if ( item.getFlag("dnd5e", "spellLevel") ) return null;   // pergaminos: nivel fijo
  const spells = actor?.system.spells ?? {};
  const minimum = item.system.level ?? 1;
  const method = CONFIG.DND5E.spellcasting[item.system.method];
  const defaultKey = method?.getSpellSlotKey?.(minimum) ?? `spell${minimum}`;
  const options = Object.entries(spells).map(([value, slot]) => {
    if ( !slot.max || !slot.type || (slot.level < minimum) ) return null;
    if ( method?.exclusive?.spells && (item.system.method !== slot.type) ) return null;
    const model = CONFIG.DND5E.spellcasting[slot.type];
    if ( model?.exclusive?.slots && (item.system.method !== slot.type) ) return null;
    const key = model?.isSingleLevel ? "BHD.Actions.SlotPact" : "BHD.Actions.SlotLevel";
    return {
      value,
      level: slot.level,
      label: game.i18n.format(key, { level: slot.level, n: slot.value ?? 0 }),
      disabled: !(slot.value > 0),
      default: value === defaultKey
    };
  }).filter(_ => _);
  return options.length ? options.sort((a, b) => a.level - b.level) : null;
}

/**
 * Niveles por encima del nivel del hechizo que da ese espacio (para subir el daño).
 * @param {Activity} activity
 * @param {string|null} slot
 * @returns {number}
 */
export function getScaling(activity, slot) {
  const level = slot ? activity.actor?.system.spells?.[slot]?.level : null;
  return level ? Math.max(0, level - (activity.item.system.level ?? 0)) : 0;
}

/**
 * La misma actividad en una copia del objeto subida de nivel (como hace dnd5e con los botones
 * de la tarjeta del chat). Sin subir de nivel, la actividad tal cual.
 * @param {Activity} activity
 * @param {number} scaling
 * @returns {Activity}
 */
export function getScaledActivity(activity, scaling) {
  if ( !scaling ) return activity;
  const item = activity.item.clone({ "flags.dnd5e.scaling": scaling }, { keepId: true });
  return item.system.activities.get(activity.id) ?? activity;
}

/**
 * ¿Usar esta actividad gasta algo (y por eso hay que "lanzarla" con su tarjeta antes de tirar)?
 * Armas normales y trucos de ataque no: su ataque y su daño se tiran directo.
 * @param {Item} item
 * @param {Activity} activity
 * @returns {boolean}
 */
export function needsCast(item, activity) {
  if ( item.type === "consumable" ) return true;
  if ( activity.requiresSpellSlot && activity.consumption?.spellSlot ) return true;
  if ( activity.consumption?.targets?.length ) return true;
  if ( activity.requiresConcentration && !game.settings.get("dnd5e", "disableConcentration") ) return true;
  return false;
}

/**
 * ¿El uso de esta actividad necesita la ventana de dnd5e (invocar, encantar...)?
 * @param {Activity} activity
 * @returns {boolean}
 */
export function needsUsageDialog(activity) {
  return !QUICK_TYPES.has(activity.type);
}

/* -------------------------------------------- */

/**
 * Datos de los botones de una fila.
 * @param {Item} item
 * @param {Activity[]} activities
 * @param {QuickActionState} [state]
 * @returns {{buttons: object[], slots: object[]|null, cast: object|null}}
 */
export function prepareRowButtons(item, activities, state) {
  const { attack, save, damage, heal, use, primary } = getRowActivities(item, activities);
  const cast = state?.getCast(item) ?? null;

  // Nivel del hechizo: selector en la propia fila (solo si hay más de una opción).
  const options = getSlotOptions(primary);
  const slot = options ? (state?.getSlot(primary) ?? null) : null;
  const scaling = primary ? getScaling(primary, slot) : 0;
  const slots = (options?.length > 1) ? options.map(o => ({ ...o, selected: o.value === slot })) : null;

  const buttons = [];
  const add = (kind, activity, data) => buttons.push({ kind, activityId: activity?.id ?? "", ...data });
  if ( attack ) add("attack", attack, {
    caption: game.i18n.localize("BHD.Actions.Attack"),
    value: attack.labels?.toHit ?? "+0",
    icon: "fa-solid fa-dice-d20"
  });
  if ( save ) add("save", save, {
    caption: game.i18n.localize("BHD.Actions.Save"),
    value: getSaveLabel(save),
    icon: "fa-solid fa-shield-heart"
  });
  if ( damage ) {
    const critical = !!(attack && (damage === attack) && state?.getLastAttack(attack)?.critical);
    const labels = getScaledActivity(damage, scaling).labels?.damage ?? [];
    add("damage", damage, {
      caption: game.i18n.localize(critical ? "BHD.Actions.Critical" : "BHD.Actions.Damage"),
      value: labels.map(l => l.formula).filter(_ => _).join(" + ") || "—",
      detail: labels.map(l => damageTypeLabel(l.damageType)).filter(_ => _).join(", "),
      icon: critical ? "fa-solid fa-burst" : "fa-solid fa-droplet",
      critical
    });
  }
  if ( heal ) {
    const labels = getScaledActivity(heal, scaling).labels?.damage ?? [];
    add("heal", heal, {
      caption: game.i18n.localize("BHD.Actions.Heal"),
      value: labels.map(l => l.formula).filter(_ => _).join(" + ") || "—",
      icon: "fa-solid fa-heart-pulse"
    });
  }
  if ( use || !primary ) add("use", use, {
    caption: "",
    value: game.i18n.localize("BHD.Actions.Use"),
    icon: "fa-solid fa-hand-sparkles"
  });

  return {
    buttons,
    slots,
    cast: cast ? {
      label: cast.slot
        ? game.i18n.format("BHD.Actions.CastAt", { level: item.actor?.system.spells?.[cast.slot]?.level ?? "" })
        : game.i18n.localize("BHD.Actions.Cast")
    } : null
  };
}

/**
 * "CD 13 DES" (o "CD 13 FUE/DES" si se puede elegir).
 * @param {Activity} activity
 * @returns {string}
 */
function getSaveLabel(activity) {
  const abilities = Array.from(activity.save?.ability ?? [])
    .map(a => (CONFIG.DND5E.abilities[a]?.abbreviation ?? a).toUpperCase());
  return game.i18n.format("BHD.Actions.SaveDC", { dc: activity.save?.dc?.value ?? "?", ability: abilities.join("/") }).trim();
}

/**
 * Nombre de un tipo de daño o curación.
 * @param {string|null} type
 * @returns {string}
 */
function damageTypeLabel(type) {
  if ( !type ) return "";
  return CONFIG.DND5E.damageTypes[type]?.label ?? CONFIG.DND5E.healingTypes[type]?.label ?? "";
}
