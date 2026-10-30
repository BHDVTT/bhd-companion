/**
 * Acciones usadas en el turno (HUD de la pestaña Combate): Acción, Acción adicional y Reacción,
 * y si el personaje usó Correr. Se guardan en el combatiente (los jugadores pueden cambiar los
 * flags de su propio combatiente) y vuelven a estar disponibles al empezar su siguiente turno.
 */

import { MODULE_ID } from "./constants.js";
import { getActiveCombat, isActorCombatant } from "./apps/combat-data.js";

/** Flag del combatiente: { key, action, bonus, reaction, dash }. */
const ECONOMY_FLAG = "economy";

/** Bloques del turno que se marcan como usados. */
export const ECONOMY_BLOCKS = ["action", "bonus", "reaction"];

/**
 * Clave del turno del combatiente: la ronda en la que empezó su último turno. Cuando cambia
 * (empieza su turno siguiente), todo vuelve a estar disponible.
 * @param {Combat} combat
 * @param {Combatant} combatant
 * @returns {string}
 */
function getTurnKey(combat, combatant) {
  const index = combat.turns.indexOf(combatant);
  const round = (combat.turn >= index) ? combat.round : combat.round - 1;
  return `${combat.id}.${round}`;
}

/**
 * Combatiente del personaje en el combate activo empezado, si lo hay.
 * @param {Actor|null} actor
 * @returns {{combat: Combat, combatant: Combatant}|null}
 */
export function getOwnCombatant(actor) {
  const combat = getActiveCombat(actor ?? null);
  if ( !combat?.started || !actor ) return null;
  const combatant = combat.combatants.find(c => isActorCombatant(c, actor));
  return combatant ? { combat, combatant } : null;
}

/**
 * Qué usó el combatiente en su turno actual.
 * @param {Combat} combat
 * @param {Combatant} combatant
 * @returns {{key: string, action: boolean, bonus: boolean, reaction: boolean, dash: boolean}}
 */
export function getEconomy(combat, combatant) {
  const key = getTurnKey(combat, combatant);
  const saved = combatant.getFlag(MODULE_ID, ECONOMY_FLAG);
  const used = (saved?.key === key) ? saved : {};
  return { key, action: !!used.action, bonus: !!used.bonus, reaction: !!used.reaction, dash: !!used.dash };
}

/**
 * Marca (o desmarca) partes del turno del combatiente.
 * @param {Combat} combat
 * @param {Combatant} combatant
 * @param {object} changes  Por ejemplo { action: true, dash: true }.
 */
export async function setEconomy(combat, combatant, changes) {
  if ( !combatant.isOwner ) return;
  const current = getEconomy(combat, combatant);
  const data = { ...current, ...changes };
  if ( ["action", "bonus", "reaction", "dash"].every(k => data[k] === current[k]) ) return;
  await combatant.setFlag(MODULE_ID, ECONOMY_FLAG, data);
}

/**
 * ¿Esta ficha usó Correr en su turno actual? (La pestaña Mover le dobla la velocidad.)
 * @param {TokenDocument} token
 * @returns {boolean}
 */
export function hasDashed(token) {
  const combat = getActiveCombat();
  if ( !combat?.started ) return false;
  const combatant = combat.combatants.find(c => c.token === token);
  return !!combatant && getEconomy(combat, combatant).dash;
}
