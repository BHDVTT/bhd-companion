/**
 * Prepara los datos de la pestaña Combate: ronda, orden de iniciativa, turno actual,
 * estado aproximado de vida y salvaciones de muerte. Solo lee datos de Foundry y dnd5e.
 */

import { MODULE_ID } from "../constants.js";

/**
 * Estado aproximado de vida: Sano con la vida completa, Herido por encima de la mitad,
 * Ensangrentado con la mitad o menos y Casi muerto con una cuarta parte o menos.
 */
const HEALTH_BLOODIED = 0.5;
const HEALTH_DYING = 0.25;

/**
 * Combate que ve este jugador: el activo en la escena activa (la que está en la TV) o,
 * si no hay, cualquier combate marcado como activo.
 * @returns {Combat|null}
 */
export function getActiveCombat() {
  const scene = game.scenes.active;
  const active = game.combats.filter(c => c.active);
  return active.find(c => !c.scene || (c.scene === scene)) ?? active[0] ?? null;
}

/**
 * ¿Este combatiente es el personaje del jugador?
 * Compara también por id porque una ficha no vinculada tiene su propia copia del personaje.
 * @param {Combatant} combatant
 * @param {Actor|null} actor
 * @returns {boolean}
 */
export function isActorCombatant(combatant, actor) {
  if ( !combatant || !actor ) return false;
  return (combatant.actor === actor) || (combatant.actorId === actor.id);
}

/**
 * ¿Hay que avisar al jugador de que es su turno en este combate?
 * @param {Combat} combat
 * @param {Actor|null} actor
 * @returns {boolean}
 */
export function isActorTurn(combat, actor) {
  return !!combat?.started && isActorCombatant(combat.combatant, actor);
}

/* -------------------------------------------- */

/**
 * Datos completos de la pestaña Combate.
 * @param {Actor|null} actor  Personaje del jugador.
 * @returns {object|null}  null si no hay combate activo.
 */
export function prepareCombat(actor) {
  const combat = getActiveCombat();
  if ( !combat ) return null;
  const showEnemyHealth = game.settings.get(MODULE_ID, "showEnemyHealth");
  const visible = combat.turns.filter(c => isVisible(c, actor));
  const current = combat.started ? combat.combatant : null;
  const next = current ? findNext(combat, current, visible) : null;

  const turns = visible.map(combatant => {
    const mine = isActorCombatant(combatant, actor);
    const isEnemy = !combatant.hasPlayerOwner;
    const defeated = combatant.isDefeated;
    return {
      id: combatant.id,
      name: combatant.name,
      img: combatant.img || CONST.DEFAULT_TOKEN,
      initiative: formatInitiative(combatant.initiative),
      current: combatant === current,
      next: combatant === next,
      mine,
      defeated,
      // El jugador ve su vida exacta en la hoja; aquí, el estado aproximado de los demás.
      health: (mine || (isEnemy && !showEnemyHealth)) ? null : getHealthState(combatant.actor, defeated)
    };
  });

  const own = combat.combatants.find(c => isActorCombatant(c, actor));
  return {
    id: combat.id,
    started: combat.started,
    round: combat.round,
    turns,
    current: turns.find(t => t.current) ?? null,
    next: turns.find(t => t.next) ?? null,
    inCombat: !!own,
    needsInitiative: !!own && own.isOwner && (own.initiative === null),
    isMyTurn: isActorTurn(combat, actor)
  };
}

/* -------------------------------------------- */

/**
 * ¿El jugador puede ver a este combatiente? Igual que el registro de combate de Foundry
 * (ocultos solo para su dueño) y además se ocultan los de fichas invisibles en el mapa.
 * @param {Combatant} combatant
 * @param {Actor|null} actor
 */
function isVisible(combatant, actor) {
  if ( isActorCombatant(combatant, actor) ) return true;
  if ( !combatant.visible ) return false;
  return combatant.isOwner || !combatant.token?.hidden;
}

/**
 * Siguiente combatiente en el orden, saltando a los derrotados si el combate lo pide
 * y a los que el jugador no ve (vuelve al principio al acabar la ronda).
 * @param {Combat} combat
 * @param {Combatant} current
 * @param {Combatant[]} visible
 * @returns {Combatant|null}
 */
function findNext(combat, current, visible) {
  const skipDefeated = combat.settings.skipDefeated;
  const turns = combat.turns;
  const start = turns.indexOf(current);
  for ( let i = 1; i < turns.length; i++ ) {
    const combatant = turns[(start + i) % turns.length];
    if ( !visible.includes(combatant) ) continue;
    if ( skipDefeated && combatant.isDefeated ) continue;
    return combatant;
  }
  return null;
}

/**
 * Iniciativa con los decimales que usa el combate, o null si aún no la tiró.
 * @param {number|null} initiative
 * @returns {string|null}
 */
function formatInitiative(initiative) {
  if ( !Number.isFinite(initiative) ) return null;
  if ( Number.isInteger(initiative) ) return String(initiative);
  return initiative.toFixed(CONFIG.Combat.initiative.decimals);
}

/**
 * Estado aproximado de vida: Sano, Herido, Ensangrentado, Casi muerto o Derrotado.
 * @param {Actor|null} actor
 * @param {boolean} defeated
 * @returns {{id: string, label: string}|null}  null si el actor no tiene vida.
 */
function getHealthState(actor, defeated) {
  const hp = actor?.system.attributes?.hp;
  if ( !hp ) return null;
  const max = hp.effectiveMax ?? hp.max;
  if ( !(max > 0) ) return null;
  const value = hp.value ?? 0;
  const pct = value / max;
  let id;
  if ( defeated || (value <= 0) ) id = "defeated";
  else if ( value >= max ) id = "healthy";
  else if ( pct > HEALTH_BLOODIED ) id = "hurt";
  else if ( pct > HEALTH_DYING ) id = "bloodied";
  else id = "dying";
  return { id, label: game.i18n.localize(`BHD.Combat.Health.${id}`) };
}

/* -------------------------------------------- */

/**
 * Salvaciones de muerte del personaje, solo si está a 0 de vida.
 * @param {Actor|null} actor
 * @returns {object|null}
 */
export function prepareDeathSaves(actor) {
  const attributes = actor?.system.attributes;
  const death = attributes?.death;
  if ( !death || (actor.type !== "character") || ((attributes.hp?.value ?? 1) > 0) ) return null;
  const success = Math.clamp(death.success ?? 0, 0, 3);
  const failure = Math.clamp(death.failure ?? 0, 0, 3);
  const dead = (failure >= 3) || actor.statuses.has(CONFIG.specialStatusEffects.DEFEATED) || actor.statuses.has("dead");
  const stable = !dead && ((success >= 3) || actor.statuses.has("stable"));
  const pips = count => [0, 1, 2].map(i => ({ filled: i < count }));
  return {
    successes: pips(success),
    failures: pips(failure),
    dead,
    stable,
    canRoll: !dead && (success < 3)
  };
}
