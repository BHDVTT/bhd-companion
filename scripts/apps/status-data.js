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

  // Condiciones (estados de dnd5e: derribado, envenenado...).
  const exhaustion = actor.system.attributes?.exhaustion ?? 0;
  const conditions = [];
  for ( const id of actor.statuses ) {
    if ( id === concentrating ) continue;
    const status = CONFIG.statusEffects.find(s => s.id === id);
    if ( !status || status.hud === false ) continue;
    conditions.push({
      id,
      name: game.i18n.localize(status.name),
      img: status.img,
      level: (id === "exhaustion") && exhaustion ? exhaustion : null
    });
  }
  conditions.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));

  // Otros efectos temporales (Bendición, Bane...) que no son una condición.
  const effects = actor.temporaryEffects
    .filter(e => !e.statuses.size && !e.disabled && e.name)
    .map(e => ({ effectId: e.id, uuid: e.uuid, name: e.name, img: e.img }));

  if ( !concentration.length && !conditions.length && !effects.length ) return null;
  return { concentration, conditions, effects };
}

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
  let key = `BHD.Conditions.${statusId}`;
  if ( (statusId === "exhaustion") && (game.settings.get("dnd5e", "rulesVersion") === "legacy") ) key += "Legacy";
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
