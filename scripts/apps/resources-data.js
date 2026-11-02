/**
 * Recursos limitados del personaje (fila de contadores de la pestaña Acciones): Ki, Furia, Puntos de hechicería,
 * Inspiración bárdica, Canalizar divinidad, Forma salvaje... No se buscan por nombre ni por clase: son los rasgos y
 * objetos con usos limitados de dnd5e (`system.uses` con máximo) y los recursos del actor (`system.resources`, de
 * las hojas antiguas). Nombre, usos que quedan, máximo y cuándo se recuperan salen de dnd5e.
 */

import { prepareRow } from "./actions-data.js";

/** Recursos del actor en `system.resources` (hojas antiguas de dnd5e). */
const ACTOR_RESOURCES = ["primary", "secondary", "tertiary"];

/** Tipos de objeto que solo cuentan si están equipados (una varita con cargas, un anillo...). */
const EQUIPPABLE = new Set(["weapon", "equipment", "tool", "loot", "container"]);

/**
 * Fila de contadores y, si hay uno abierto, su detalle.
 * @param {Actor} actor
 * @param {string|null} openId  Contador abierto (id del objeto o "resource.<clave>").
 * @param {object} [state]      Estado de los botones rápidos (QuickActionState), para el detalle.
 * @returns {{counters: object[], open: object|null}|null}
 */
export function prepareResources(actor, openId, state) {
  const counters = [];

  for ( const item of actor.items ) {
    if ( !hasLimitedUses(item) ) continue;
    const uses = item.system.uses;
    counters.push({
      id: item.id,
      name: item.name,
      img: item.img,
      value: uses.value ?? Math.max(0, uses.max - (uses.spent ?? 0)),
      max: uses.max,
      recovery: getRecoveryLabels(uses.recovery),
      item
    });
  }

  for ( const key of ACTOR_RESOURCES ) {
    const resource = actor.system.resources?.[key];
    if ( !resource?.max || !resource.label ) continue;
    const recovery = [];
    if ( resource.sr ) recovery.push(periodLabel("sr"));
    if ( resource.lr ) recovery.push(periodLabel("lr"));
    counters.push({
      id: `resource.${key}`,
      name: resource.label,
      img: null,
      value: resource.value ?? 0,
      max: resource.max,
      recovery: recovery.filter(_ => _),
      resourceKey: key
    });
  }
  if ( !counters.length ) return null;

  counters.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
  for ( const counter of counters ) {
    counter.empty = counter.value <= 0;
    counter.active = counter.id === openId;
    counter.recoveryText = counter.recovery.join(" · ");
  }

  const open = counters.find(c => c.active) ?? null;
  return {
    counters: counters.map(({ item, ...rest }) => rest),
    open: open ? {
      ...Object.fromEntries(Object.entries(open).filter(([k]) => k !== "item")),
      canDecrease: open.value > 0,
      canIncrease: open.value < open.max,
      // Las actividades del rasgo, con los mismos botones y el mismo flujo que en la lista de Acciones.
      row: open.item ? prepareRow(open.item, { state }) : null
    } : null
  };
}

/**
 * ¿El objeto tiene usos limitados que se deban ver como contador?
 * Hechizos y consumibles no: ya tienen su sitio (espacios de conjuro, cantidad).
 * @param {Item} item
 * @returns {boolean}
 */
function hasLimitedUses(item) {
  if ( ["spell", "consumable"].includes(item.type) ) return false;
  const uses = item.system.uses;
  if ( !(uses?.max > 0) ) return false;
  if ( item.system.hasLimitedUses === false ) return false;
  if ( EQUIPPABLE.has(item.type) && !item.system.equipped ) return false;
  return true;
}

/**
 * Cuándo se recuperan los usos, con los textos de dnd5e (`CONFIG.DND5E.limitedUsePeriods`).
 * @param {object[]} recovery  `system.uses.recovery`.
 * @returns {string[]}
 */
function getRecoveryLabels(recovery) {
  return (recovery ?? []).map(r => {
    if ( r.period === "recharge" ) {
      return game.i18n.format("BHD.Resources.Recharge", { value: r.formula || "6" });
    }
    return periodLabel(r.period);
  }).filter(_ => _);
}

/**
 * @param {string} period
 * @returns {string}
 */
function periodLabel(period) {
  const config = CONFIG.DND5E.limitedUsePeriods?.[period];
  return config ? game.i18n.localize(config.label) : "";
}

/**
 * Cambia a mano los usos que quedan (+1 / -1).
 * @param {Actor} actor
 * @param {string} id     Id del objeto o "resource.<clave>".
 * @param {number} delta  +1 recupera un uso, -1 gasta uno.
 * @returns {Promise<void>}
 */
export async function adjustResource(actor, id, delta) {
  if ( id.startsWith("resource.") ) {
    const key = id.slice("resource.".length);
    const resource = actor.system.resources?.[key];
    if ( !resource ) return;
    const value = Math.clamp((resource.value ?? 0) + delta, 0, resource.max ?? 0);
    await actor.update({ [`system.resources.${key}.value`]: value });
    return;
  }
  const item = actor.items.get(id);
  const uses = item?.system.uses;
  if ( !uses?.max ) return;
  // dnd5e guarda los usos gastados: recuperar uno es gastar uno menos.
  const spent = Math.clamp((uses.spent ?? 0) - delta, 0, uses.max);
  await item.update({ "system.uses.spent": spent });
}
