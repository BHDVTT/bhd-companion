/**
 * Prepara los datos de la pestaña Mover: qué ficha se mueve, pies usados y restantes,
 * y si ahora se puede mover. El movimiento en sí lo hace el DM (ver scripts/movement.js).
 */

import { canUndoMovement, getMovementBlock, getMovementState, getMovementUsed, getTokenCombat } from "../movement.js";
import { hasDashed } from "../economy.js";

/** Botones de la cruceta, en orden de la cuadrícula 3 × 3 (null = centro, el retrato). */
const PAD = [
  { direction: "up-left", icon: "fa-arrow-up-left", diagonal: true },
  { direction: "up", icon: "fa-arrow-up" },
  { direction: "up-right", icon: "fa-arrow-up-right", diagonal: true },
  { direction: "left", icon: "fa-arrow-left" },
  null,
  { direction: "right", icon: "fa-arrow-right" },
  { direction: "down-left", icon: "fa-arrow-down-left", diagonal: true },
  { direction: "down", icon: "fa-arrow-down" },
  { direction: "down-right", icon: "fa-arrow-down-right", diagonal: true }
];

/**
 * Fichas de la escena activa (la de la TV) que este jugador puede mover.
 * @returns {TokenDocument[]}
 */
export function getMovableTokens() {
  const scene = game.scenes.active;
  if ( !scene ) return [];
  return scene.tokens.filter(token => token.isOwner);
}

/**
 * Ficha que se mueve: la elegida en el selector o, si no, la del personaje del jugador.
 * @param {Actor|null} actor
 * @param {string|null} selectedId
 * @returns {TokenDocument|null}
 */
export function getMoveToken(actor, selectedId) {
  const tokens = getMovableTokens();
  return tokens.find(t => t.id === selectedId)
    ?? tokens.find(t => actor && ((t.actor === actor) || (t.actorId === actor.id)))
    ?? tokens[0] ?? null;
}

/**
 * Datos de la pestaña Mover.
 * @param {Actor|null} actor
 * @param {string|null} selectedId  Ficha elegida en el selector.
 * @returns {object}
 */
export function prepareMovement(actor, selectedId) {
  const scene = game.scenes.active;
  const token = getMoveToken(actor, selectedId);
  if ( !token ) return { token: null, noScene: !scene };

  const { formatNumber } = dnd5e.utils;
  const units = scene.grid.units || "";
  const used = Math.round(getMovementUsed(token) * 10) / 10;
  // Correr (desde el HUD de combate) dobla la velocidad en este turno.
  const dashed = hasDashed(token);
  const speed = getSpeed(token) * (dashed ? 2 : 1);
  const remaining = speed - used;
  const block = getMovementBlock(token, game.user);
  const inCombat = !!getTokenCombat(token);
  const noDiagonals = scene.grid.diagonals === CONST.GRID_DIAGONALS.ILLEGAL;

  const tokens = getMovableTokens();
  return {
    token: { id: token.id, name: token.name, img: token.texture.src || CONST.DEFAULT_TOKEN },
    choices: (tokens.length > 1) ? tokens.map(t => ({ id: t.id, name: t.name, selected: t === token })) : null,
    used: formatNumber(used),
    speed: speed ? formatNumber(speed) : null,
    remaining: formatNumber(Math.max(remaining, 0)),
    over: !!speed && (remaining < 0),
    extra: formatNumber(Math.max(-remaining, 0)),
    percent: speed ? Math.min(Math.round((used / speed) * 100), 100) : 0,
    units,
    dashed,
    inCombat,
    block: block ? `BHD.Move.Reason.${block}` : null,
    pad: PAD.map(button => button && { ...button, disabled: !!block || (button.diagonal && noDiagonals) }),
    canUndo: !block && canUndoMovement(token),
    canReset: !block && !inCombat && (getMovementState(token).path.length > 1)
  };
}

/**
 * Velocidad de la ficha para su forma de moverse (andar, volar, nadar...), de dnd5e.
 * @param {TokenDocument} token
 * @returns {number}
 */
export function getSpeed(token) {
  const movement = token.actor?.system.attributes?.movement ?? {};
  const speed = movement[token.movementAction] ?? movement.walk;
  return Number(speed) || 0;
}
