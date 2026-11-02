/**
 * Concentración, condiciones y efectos activos del personaje (hoja de personaje y pestaña Combate).
 * Solo lee datos de dnd5e: `actor.concentration`, `actor.statuses`, `CONFIG.statusEffects` y los efectos
 * temporales del actor.
 */

/**
 * Datos de la sección de estado, o null si no hay nada que mostrar.
 * @param {Actor|null} actor
 * @returns {{concentration: object[], conditions: object[], effects: object[]}|null}
 */
export function prepareStatus(actor) {
  if ( !actor ) return null;
  const concentrating = CONFIG.specialStatusEffects.CONCENTRATING;

  // Concentración: un efecto por hechizo (dnd5e permite más de uno con algunas reglas).
  const concentration = Array.from(actor.concentration?.effects ?? []).map(effect => {
    const data = effect.getFlag("dnd5e", "item") ?? {};
    const item = actor.items.get(data.id);
    return {
      effectId: effect.id,
      name: item?.name ?? data.data?.name ?? game.i18n.localize("BHD.Status.Concentrating"),
      img: item?.img ?? effect.img
    };
  });

  // Condiciones (estados de dnd5e: derribado, envenenado...), con la duración del efecto que la da si tiene.
  const exhaustion = actor.system.attributes?.exhaustion ?? 0;
  const conditions = [];
  for ( const id of actor.statuses ) {
    if ( id === concentrating ) continue;
    const status = CONFIG.statusEffects.find(s => s.id === id);
    if ( !status || status.hud === false ) continue;
    const source = actor.appliedEffects?.find(e => e.statuses.has(id) && e.isTemporary && getDuration(e).label);
    const timing = source ? describeEffect(source, actor) : {};
    conditions.push({
      id,
      name: game.i18n.localize(status.name),
      img: status.img,
      level: (id === "exhaustion") && exhaustion ? exhaustion : null,
      duration: timing.duration ?? null,
      lastRound: !!timing.lastRound
    });
  }
  conditions.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));

  // Otros efectos temporales (Bendición, Marca del cazador, Prisa...) que no son una condición.
  const effects = actor.temporaryEffects
    .filter(e => !e.statuses.size && !e.disabled && e.name)
    .map(e => ({ effectId: e.id, uuid: e.uuid, name: e.name, img: e.img, ...describeEffect(e, actor) }));

  if ( !concentration.length && !conditions.length && !effects.length ) return null;
  return { concentration, conditions, effects };
}

/* -------------------------------------------- */
/*  Duración y origen de un efecto              */
/* -------------------------------------------- */

/**
 * Duración ya calculada por Foundry (`ActiveEffect#duration`). En v13 trae `type` ("turns" en combate); en v14,
 * `units` ("rounds", "turns", "minutes"...) y `expired`. Las dos traen `remaining` y `label`.
 * @param {ActiveEffect} effect
 * @returns {{label: string, remaining: number|null, combat: boolean, expired: boolean}}
 */
export function getDuration(effect) {
  const duration = effect.duration ?? {};
  const remaining = Number.isFinite(duration.remaining) ? duration.remaining : null;
  const combat = (duration.type === "turns") || ["rounds", "turns"].includes(duration.units);
  const timed = (duration.type && (duration.type !== "none")) || !!duration.units;
  const expired = (duration.expired === true) || (timed && (remaining !== null) && (remaining <= 0));
  return { label: timed && (remaining !== null) ? (duration.label ?? "") : "", remaining, combat, expired };
}

/**
 * Lo que se enseña de un efecto: duración que queda, si está en su última ronda y quién lo aplicó.
 * @param {ActiveEffect} effect
 * @param {Actor} actor  Actor que tiene el efecto.
 * @returns {{duration: string|null, lastRound: boolean, source: string|null}}
 */
export function describeEffect(effect, actor) {
  const { label, remaining, combat, expired } = getDuration(effect);
  return {
    duration: expired ? game.i18n.localize("BHD.Effects.Ended") : (label || null),
    lastRound: combat && !expired && (remaining !== null) && (remaining > 0) && (remaining <= 1),
    source: getEffectSource(effect, actor)
  };
}

/**
 * Quién aplicó el efecto (`ActiveEffect#origin`): la criatura y lo que usó ("Clérigo · Bendición").
 * Null si lo aplicó el propio actor con algo suyo y no hay más que decir.
 * @param {ActiveEffect} effect
 * @param {Actor} actor
 * @returns {string|null}
 */
export function getEffectSource(effect, actor) {
  if ( !effect.origin ) return null;
  let origin = null;
  try {
    origin = fromUuidSync(effect.origin, { strict: false });
  } catch(err) {
    return null;
  }
  if ( !origin ) return null;
  const originActor = (origin instanceof Actor) ? origin : (origin.actor ?? origin.parent?.actor ?? null);
  const itemName = (origin instanceof Item) ? origin.name : (origin.item?.name ?? null);
  if ( originActor && (originActor !== actor) ) return [originActor.name, itemName].filter(_ => _).join(" · ");
  return (itemName && (itemName !== effect.name)) ? itemName : null;
}

/**
 * ¿Puede el jugador quitar este efecto? Solo si es dueño del efecto y lo aplicó él mismo (o algo suyo, o no se sabe
 * quién): un Bendición del clérigo o un Hechizar del enemigo no se quitan desde aquí.
 * @param {ActiveEffect} effect
 * @returns {boolean}
 */
export function canRemoveEffect(effect) {
  if ( !effect.isOwner ) return false;
  if ( !effect.origin ) return true;
  let origin = null;
  try {
    origin = fromUuidSync(effect.origin, { strict: false });
  } catch(err) {
    return false;
  }
  const originActor = (origin instanceof Actor) ? origin : (origin?.actor ?? origin?.parent?.actor ?? null);
  return !originActor || originActor.isOwner;
}

/**
 * Cambios que hace el efecto, en texto: "Atributo · Sumar · +1". Las claves son las de dnd5e (`system.bonuses...`);
 * si dnd5e o Foundry dan un nombre para la clave, se usa ese.
 * @param {ActiveEffect} effect
 * @returns {{key: string, mode: string, value: string}[]}
 */
export function getEffectChanges(effect) {
  // v13: effect.changes; v14: effect.system.changes.
  const changes = Array.isArray(effect.changes) ? effect.changes : (effect.system?.changes ?? []);
  const modes = Object.fromEntries(Object.entries(CONST.ACTIVE_EFFECT_MODES ?? {}).map(([k, v]) => [v, k]));
  return changes.map(change => {
    const modeName = (typeof change.mode === "number") ? modes[change.mode] : change.type ?? change.mode;
    const modeKey = modeName ? `EFFECT.MODE_${String(modeName).toUpperCase()}` : null;
    return {
      key: change.key ?? "",
      mode: (modeKey && game.i18n.has(modeKey)) ? game.i18n.localize(modeKey) : (modeName ?? ""),
      value: String(change.value ?? "")
    };
  }).filter(c => c.key);
}

/* -------------------------------------------- */

/**
 * Explicación breve de una condición: la del módulo (en español sencillo) o, si no hay, el texto
 * de la regla que enlaza dnd5e.
 * @param {string} statusId
 * @param {Actor} actor
 * @returns {Promise<{name: string, img: string, html: string}|null>}
 */
export async function getConditionInfo(statusId, actor) {
  const status = CONFIG.statusEffects.find(s => s.id === statusId);
  if ( !status ) return null;
  const name = game.i18n.localize(status.name);
  const escape = foundry.utils.escapeHTML;
  const key = `BHD.Conditions.${statusId}`;
  if ( game.i18n.has(key) ) {
    let html = `<p>${escape(game.i18n.localize(key))}</p>`;
    const level = actor?.system.attributes?.exhaustion;
    if ( (statusId === "exhaustion") && level ) {
      html = `<p><strong>${escape(game.i18n.format("BHD.Status.ExhaustionLevel", { level }))}</strong></p>${html}`;
    }
    return { name, img: status.img, html };
  }
  const reference = status.reference ?? CONFIG.DND5E.conditionTypes[statusId]?.reference;
  const page = reference ? await fromUuid(reference).catch(() => null) : null;
  const text = page?.text?.content;
  const html = text
    ? await foundry.applications.ux.TextEditor.implementation.enrichHTML(text, { relativeTo: page })
    : `<p>${escape(game.i18n.localize("BHD.Status.NoDescription"))}</p>`;
  return { name, img: status.img, html };
}
