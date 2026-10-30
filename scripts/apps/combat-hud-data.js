/**
 * Prepara el HUD de turno de la pestaña Combate: bloques Acción, Acción adicional, Reacción y
 * Movimiento, las opciones de cada bloque y las tarjetas del selector de objetivos.
 * Solo lee datos de Foundry y dnd5e (actividades, objetivos, velocidad, distancias de la cuadrícula).
 */

import { isSpellShown, prepareRow } from "./actions-data.js";
import { describeHealth, isActorCombatant } from "./combat-data.js";
import { getMoveToken, getSpeed } from "./move-data.js";
import { getMovementUsed } from "../movement.js";
import { getEconomy, getOwnCombatant } from "../economy.js";
import { getTargetIds } from "../targets.js";

/** Bloques del HUD, en orden. */
const BLOCKS = [
  { id: "action", icon: "fa-solid fa-hand-fist" },
  { id: "bonus", icon: "fa-solid fa-bolt" },
  { id: "reaction", icon: "fa-solid fa-rotate-left" },
  { id: "move", icon: "fa-solid fa-person-running" }
];

/**
 * Acciones que todo personaje puede hacer (bloque Acción). `target`: pide un objetivo;
 * `skill`: tira esa habilidad; `status`: estado de dnd5e que se pone al personaje.
 */
export const BASIC_ACTIONS = [
  { id: "dodge", icon: "fa-solid fa-shield-halved", status: "dodging" },
  { id: "dash", icon: "fa-solid fa-person-running" },
  { id: "disengage", icon: "fa-solid fa-person-walking-arrow-right" },
  { id: "help", icon: "fa-solid fa-handshake-angle", target: true },
  { id: "hide", icon: "fa-solid fa-eye-slash", skill: "ste" },
  { id: "search", icon: "fa-solid fa-magnifying-glass", skill: "prc" },
  { id: "ready", icon: "fa-solid fa-hourglass-half" }
];

/** Tipos de objetivo de dnd5e que no se eligen en el selector (uno mismo, un punto del mapa). */
const UNTARGETED_TYPES = new Set(["self", "space"]);

/* -------------------------------------------- */

/**
 * Actividades de un objeto que se usan con este bloque del turno.
 * "opportunity" (ataque de oportunidad, con la reacción) son los ataques de las armas.
 * @param {Item} item
 * @param {string} block  "action", "bonus", "reaction" u "opportunity".
 * @returns {Activity[]}
 */
export function getBlockActivities(item, block) {
  const activities = item.system.activities?.filter(a => a.canUse) ?? [];
  if ( block === "opportunity" ) return activities.filter(a => a.type === "attack");
  return activities.filter(a => a.activation?.type === block);
}

/**
 * ¿Estas actividades necesitan elegir objetivos? Las de área no (el área se coloca en el mapa),
 * ni las que afectan solo a uno mismo. Los ataques siempre.
 * @param {Activity[]} activities
 * @returns {{max: number}|null}  Cuántos objetivos como mucho, o null si no hace falta elegir.
 */
export function getTargetNeed(activities) {
  let max = 0;
  for ( const activity of activities ) {
    const target = activity.target ?? {};
    if ( target.template?.type ) continue;
    const type = target.affects?.type;
    if ( UNTARGETED_TYPES.has(type) ) continue;
    if ( !type && (activity.type !== "attack") ) continue;
    let count = 1;
    if ( target.affects?.count ) {
      count = Number(dnd5e.utils.simplifyBonus(target.affects.count, activity.getRollData?.() ?? {})) || 1;
    }
    max = Math.max(max, count);
  }
  return max ? { max } : null;
}

/* -------------------------------------------- */

/**
 * Datos del HUD de turno, o null si el personaje no está en un combate empezado.
 * @param {Actor|null} actor
 * @param {string|null} openBlock  Bloque abierto ("action", "bonus" o "reaction").
 * @param {QuickActionState} [state]  Botones de tirada: nivel elegido, lanzamientos, críticos.
 * @returns {object|null}
 */
export function prepareHud(actor, openBlock, state) {
  const own = getOwnCombatant(actor);
  if ( !own ) return null;
  const { combat, combatant } = own;
  const economy = getEconomy(combat, combatant);
  const localize = key => game.i18n.localize(key);

  const blocks = BLOCKS.map(block => ({
    ...block,
    label: localize(`BHD.Hud.Block.${block.id}`),
    used: !!economy[block.id],
    open: block.id === openBlock
  }));
  const moveBlock = blocks.find(b => b.id === "move");
  moveBlock.move = prepareMoveBlock(actor, combatant, economy.dash);
  moveBlock.used = !!moveBlock.move.spent;

  const panelBlock = blocks.find(b => b.open && (b.id !== "move"));
  return {
    blocks,
    isMyTurn: isActorCombatant(combat.combatant, actor),
    panel: panelBlock ? preparePanel(actor, panelBlock, state) : null,
    targets: prepareTargetChips()
  };
}

/**
 * Bloque Movimiento: pies usados de la velocidad (doble si usó Correr).
 * @param {Actor} actor
 * @param {Combatant} combatant
 * @param {boolean} dashed
 * @returns {object}
 */
function prepareMoveBlock(actor, combatant, dashed) {
  const scene = game.scenes.active;
  const token = (combatant.token?.parent === scene) ? combatant.token : getMoveToken(actor, null);
  if ( !token ) return { none: true };
  const { formatNumber } = dnd5e.utils;
  const used = Math.round(getMovementUsed(token) * 10) / 10;
  const speed = getSpeed(token) * (dashed ? 2 : 1);
  return {
    used: formatNumber(used),
    speed: speed ? formatNumber(speed) : null,
    units: scene?.grid.units || "",
    percent: speed ? Math.min(Math.round((used / speed) * 100), 100) : 0,
    spent: !!speed && (used >= speed),
    over: !!speed && (used > speed),
    dashed
  };
}

/**
 * Opciones de un bloque: ataques, hechizos, rasgos y objetos de ese tipo de acción, más las
 * acciones básicas (bloque Acción) o el ataque de oportunidad (bloque Reacción).
 * @param {Actor} actor
 * @param {object} block
 * @param {QuickActionState} [state]
 * @returns {object}
 */
function preparePanel(actor, block, state) {
  const groups = { attacks: [], spells: [], features: [], items: [] };
  const opportunity = [];
  for ( const item of actor.items ) {
    const type = item.type;
    const equipped = item.system.equipped ?? true;
    if ( (type === "weapon") && equipped && (block.id === "reaction") && getBlockActivities(item, "opportunity").length ) {
      opportunity.push(item);
    }
    if ( !getBlockActivities(item, block.id).length ) continue;
    if ( type === "weapon" ) {
      if ( equipped ) groups.attacks.push(item);
    }
    else if ( type === "spell" ) {
      if ( isSpellShown(item, actor) && (!item.getFlag("dnd5e", "cachedFor") || item.system.linkedActivity?.displayInSpellbook) ) {
        groups.spells.push(item);
      }
    }
    else if ( type === "feat" ) groups.features.push(item);
    else if ( type === "consumable" ) {
      if ( (item.system.type?.value !== "ammo") && (item.system.quantity > 0) ) groups.items.push(item);
    }
    else if ( equipped ) groups.items.push(item);
  }

  const byName = (a, b) => a.name.localeCompare(b.name, game.i18n.lang);
  const byLevel = (a, b) => ((a.system.level ?? 0) - (b.system.level ?? 0)) || byName(a, b);
  // Los botones de cada fila usan solo las actividades de ese bloque (un arma con la reacción: su ataque).
  const toRows = (items, hudBlock, sort=byName) => items.sort(sort).map(item => ({
    ...prepareRow(item, { showLevel: true, state, activities: getBlockActivities(item, hudBlock) }), hudBlock
  }));

  const sections = [
    { id: "attacks", label: "BHD.Actions.Attacks", rows: toRows(groups.attacks, block.id) },
    { id: "opportunity", label: "BHD.Hud.Opportunity", hint: "BHD.Hud.OpportunityHint", rows: toRows(opportunity, "opportunity") },
    { id: "spells", label: "BHD.Actions.Spells", rows: toRows(groups.spells, block.id, byLevel) },
    { id: "features", label: "BHD.Actions.Features", rows: toRows(groups.features, block.id) },
    { id: "items", label: "BHD.Hud.Items", rows: toRows(groups.items, block.id) }
  ].filter(section => section.rows.length);

  const basics = (block.id === "action") ? BASIC_ACTIONS.map(basic => ({
    ...basic,
    label: game.i18n.localize(`BHD.Hud.Basic.${basic.id}.Name`),
    hint: game.i18n.localize(`BHD.Hud.Basic.${basic.id}.Hint`)
  })) : [];

  return {
    id: block.id,
    label: block.label,
    icon: block.icon,
    used: block.used,
    sections,
    basics,
    empty: !sections.length && !basics.length
  };
}

/* -------------------------------------------- */
/*  Objetivos                                   */
/* -------------------------------------------- */

/**
 * Objetivos marcados ahora mismo (para la barra de objetivos del HUD).
 * @returns {{id: string, name: string, img: string}[]}
 */
export function prepareTargetChips() {
  const scene = game.scenes.active;
  return getTargetIds().map(id => scene?.tokens.get(id)).filter(t => t).map(token => ({
    id: token.id, name: token.name, img: getTokenImage(token)
  }));
}

/**
 * Tarjetas del selector de objetivos: fichas de la escena activa (la de la TV) que el jugador
 * puede ver, ordenadas por cercanía a su ficha, con la distancia y el estado aproximado de vida.
 * Sin mapa no se puede calcular qué ve el personaje: se ocultan solo las fichas ocultas por el DM.
 * @param {Actor|null} actor
 * @returns {object[]}
 */
export function prepareTargetCards(actor) {
  const scene = game.scenes.active;
  if ( !scene ) return [];
  const origin = getMoveToken(actor, null);
  const selected = new Set(getTargetIds());
  const { formatNumber } = dnd5e.utils;
  const units = scene.grid.units || "";

  const cards = scene.tokens.filter(token => token.actor && (!token.hidden || token.isOwner)).map(token => {
    const mine = token === origin;
    const tokenActor = token.actor;
    const defeated = tokenActor.statuses?.has(CONFIG.specialStatusEffects.DEFEATED) ?? false;
    const health = describeHealth(tokenActor, { mine, isEnemy: !tokenActor.hasPlayerOwner, defeated });
    const distance = (origin && !mine) ? measureDistance(origin, token) : null;
    return {
      id: token.id,
      name: token.name,
      img: getTokenImage(token),
      mine,
      defeated: defeated || (health?.id === "defeated"),
      health,
      distance,
      distanceLabel: Number.isFinite(distance) ? `${formatNumber(distance)} ${units}`.trim() : null,
      selected: selected.has(token.id)
    };
  });

  // Primero los vivos más cercanos; los derrotados y la ficha propia, al final.
  return cards.sort((a, b) => (a.mine - b.mine) || (a.defeated - b.defeated)
    || ((a.distance ?? Infinity) - (b.distance ?? Infinity)) || a.name.localeCompare(b.name, game.i18n.lang));
}

/**
 * Distancia entre dos fichas como la cuenta D&D: de casilla a casilla más cercana (las criaturas
 * grandes ocupan varias), con la regla de diagonales de la escena. En mapas sin cuadrícula
 * o hexagonales, de centro a centro.
 * @param {TokenDocument} from
 * @param {TokenDocument} to
 * @returns {number}
 */
function measureDistance(from, to) {
  const grid = from.parent.grid;
  if ( !grid.isSquare ) return grid.measurePath([from.getCenterPoint(), to.getCenterPoint()]).distance;
  const range = token => grid.getOffsetRange({ x: token.x, y: token.y, ...token.getSize() });
  const [ai0, aj0, ai1, aj1] = range(from);
  const [bi0, bj0, bi1, bj1] = range(to);
  const di = Math.max(0, bi0 - ai1 + 1, ai0 - bi1 + 1);
  const dj = Math.max(0, bj0 - aj1 + 1, aj0 - bj1 + 1);
  const start = grid.getCenterPoint({ i: 0, j: 0 });
  const end = grid.getCenterPoint({ i: di, j: dj });
  return grid.measurePath([start, end]).distance;
}

/**
 * Imagen de la ficha para una etiqueta <img> (si la ficha es un vídeo, el retrato del actor).
 * @param {TokenDocument} token
 * @returns {string}
 */
export function getTokenImage(token) {
  const src = token.texture?.src;
  if ( src && !/\.(webm|mp4|m4v|ogv)$/i.test(src) ) return src;
  return token.actor?.img || CONST.DEFAULT_TOKEN;
}
