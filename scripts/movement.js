/**
 * Mover la ficha desde el teléfono (pestaña Mover).
 *
 * El mapa del teléfono está oculto (o no existe, en modo ligero), así que los pasos no se deciden ahí:
 * se siguen comprobando en el DM, que es quien ve la escena en la TV. Cada paso se
 * pide por el canal del módulo al cliente del DM activo, que sí tiene el mapa: comprueba si el
 * jugador puede moverse, si hay una pared, y mueve la ficha con el movimiento normal de Foundry
 * (`TokenDocument#move`). Después avisa a las pantallas con mapa (la TV) para que sigan la ficha.
 */

import { MODULE_ID } from "./constants.js";
import { getActiveCombat } from "./apps/combat-data.js";
import { isMobileView } from "./mobile-mode.js";

const SOCKET = `module.${MODULE_ID}`;

/** Flag de la ficha donde se guarda el camino recorrido en el turno: { key, path }. */
const MOVE_FLAG = "movement";

/** Cuánto se espera (ms) la respuesta del DM antes de darse por vencido. */
const RESPONSE_TIMEOUT = 5000;

/** Direcciones de la cruceta: [dx, dy] en casillas. */
export const DIRECTIONS = {
  "up-left": [-1, -1], up: [0, -1], "up-right": [1, -1],
  left: [-1, 0], right: [1, 0],
  "down-left": [-1, 1], down: [0, 1], "down-right": [1, 1]
};

/** Respuestas pendientes de este teléfono, por id de petición. */
const pendingRequests = new Map();

/** Peticiones que atiende el DM, una detrás de otra (dos pasos seguidos no deben pisarse). */
let gmQueue = Promise.resolve();

/* -------------------------------------------- */
/*  Reglas (las usan el teléfono y el DM)       */
/* -------------------------------------------- */

/**
 * Combate empezado en el que participa esta ficha, si lo hay.
 * @param {TokenDocument} token
 * @returns {Combat|null}
 */
export function getTokenCombat(token) {
  const combat = getActiveCombat();
  if ( !combat?.started ) return null;
  return combat.combatants.some(c => c.token === token) ? combat : null;
}

/**
 * Por qué esta ficha no se puede mover ahora mismo, o null si se puede.
 * @param {TokenDocument|null} token
 * @param {User} user  Jugador que la quiere mover.
 * @returns {string|null}  Clave de BHD.Move.Reason.*
 */
export function getMovementBlock(token, user) {
  if ( !token ) return "NoToken";
  if ( !token.testUserPermission(user, "OWNER") ) return "NotOwner";
  if ( game.settings.get(MODULE_ID, "lockMovement") ) return "Locked";
  if ( game.paused ) return "Paused";
  if ( token.locked ) return "TokenLocked";
  const combat = getTokenCombat(token);
  const outsideTurn = game.settings.get(MODULE_ID, "moveOutsideTurn");
  if ( combat && !outsideTurn && (combat.combatant?.token !== token) ) return "NotYourTurn";
  return null;
}

/**
 * Clave del tramo de movimiento actual. En combate cambia al empezar el turno de la ficha
 * (ronda en la que empezó su último turno); fuera de combate es siempre "free".
 * Cuando la clave cambia, el conteo de pies vuelve a cero.
 * @param {TokenDocument} token
 * @returns {string}
 */
function getMoveKey(token) {
  const combat = getTokenCombat(token);
  if ( !combat ) return "free";
  const index = combat.turns.findIndex(c => c.token === token);
  const round = (combat.turn >= index) ? combat.round : combat.round - 1;
  return `${combat.id}.${round}`;
}

/**
 * Camino recorrido en el tramo actual: la posición inicial y cada paso.
 * Los saltos (el DM movió la ficha a mano) llevan action "displace" y no cuentan pies.
 * @param {TokenDocument} token
 * @returns {{key: string, path: {x: number, y: number, elevation: number, action: string}[]}}
 */
export function getMovementState(token) {
  const saved = token.getFlag(MODULE_ID, MOVE_FLAG);
  const key = getMoveKey(token);
  const path = ((saved?.key === key) && Array.isArray(saved.path)) ? saved.path : [];
  return { key, path };
}

/**
 * Pies recorridos en el tramo actual, medidos por Foundry con la regla de diagonales de la escena.
 * @param {TokenDocument} token
 * @returns {number}
 */
export function getMovementUsed(token) {
  const { path } = getMovementState(token);
  if ( path.length < 2 ) return 0;
  return token.measureMovementPath(path).distance ?? 0;
}

/**
 * ¿Se puede deshacer el último paso? Solo si fue un paso (no un salto del DM) y la ficha
 * sigue donde la dejó.
 * @param {TokenDocument} token
 * @returns {boolean}
 */
export function canUndoMovement(token) {
  const { path } = getMovementState(token);
  const last = path.at(-1);
  return (path.length > 1) && (last.action !== "displace") && isSamePosition(last, token._source);
}

/**
 * @param {{x: number, y: number}} a
 * @param {{x: number, y: number}} b
 */
function isSamePosition(a, b) {
  return (Math.round(a.x) === Math.round(b.x)) && (Math.round(a.y) === Math.round(b.y));
}

/* -------------------------------------------- */
/*  Canal del módulo                            */
/* -------------------------------------------- */

/**
 * Escucha el canal del módulo. Se llama en "ready" en todos los clientes:
 * el DM activo atiende los pasos, las pantallas con mapa siguen la ficha y el teléfono
 * recibe las respuestas.
 */
export function registerMovementSocket() {
  // El servidor de Foundry añade el id real de quien envía el mensaje.
  game.socket.on(SOCKET, (data, senderId) => {
    switch ( data?.type ) {
      case "moveRequest":
        if ( game.user.isActiveGM ) queueGMRequest(data, senderId);
        break;
      case "moveResult":
        pendingRequests.get(data.requestId)?.(data);
        break;
      case "follow":
        followToken(data.sceneId, data.tokenId);
        break;
    }
  });
}

/**
 * Pide al DM un paso, deshacer o reiniciar el conteo. Lo usa el teléfono.
 * @param {"step"|"undo"|"reset"} action
 * @param {TokenDocument} token
 * @param {string} [direction]  Para "step": una clave de DIRECTIONS.
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export function requestMovement(action, token, direction) {
  if ( !game.users.activeGM ) return Promise.resolve({ ok: false, reason: "NoGM" });
  const requestId = foundry.utils.randomID();
  return new Promise(resolve => {
    const timeout = setTimeout(() => finish({ ok: false, reason: "NoResponse" }), RESPONSE_TIMEOUT);
    function finish(result) {
      clearTimeout(timeout);
      pendingRequests.delete(requestId);
      resolve(result);
    }
    pendingRequests.set(requestId, finish);
    game.socket.emit(SOCKET, {
      type: "moveRequest", requestId, action, direction,
      sceneId: token.parent.id, tokenId: token.id
    }, { recipients: [game.users.activeGM.id] });
  });
}

/* -------------------------------------------- */
/*  Lado del DM                                 */
/* -------------------------------------------- */

/**
 * Atiende una petición del teléfono cuando termine la anterior y responde solo a ese jugador.
 * @param {object} data
 * @param {string} senderId
 */
function queueGMRequest(data, senderId) {
  gmQueue = gmQueue.then(async () => {
    let result;
    try {
      result = await handleGMRequest(data, game.users.get(senderId));
    } catch(err) {
      console.error("BHD Companion | No se pudo mover la ficha", err);
      result = { ok: false, reason: "Error" };
    }
    game.socket.emit(SOCKET, { type: "moveResult", requestId: data.requestId, ...result }, { recipients: [senderId] });
  });
}

/**
 * @param {object} data
 * @param {User} user
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function handleGMRequest(data, user) {
  const token = game.scenes.get(data.sceneId)?.tokens.get(data.tokenId) ?? null;
  if ( !user ) return { ok: false, reason: "Error" };
  const block = getMovementBlock(token, user);
  if ( block ) return { ok: false, reason: block };
  switch ( data.action ) {
    case "step": return stepToken(token, data.direction);
    case "undo": return undoStep(token);
    case "reset": return resetMovement(token);
  }
  return { ok: false, reason: "Error" };
}

/**
 * Mueve la ficha una casilla, como con las flechas del teclado en Foundry, si no hay pared en medio.
 * @param {TokenDocument} token
 * @param {string} direction
 */
async function stepToken(token, direction) {
  // Las paredes solo se pueden comprobar con la escena dibujada en el mapa del DM.
  const object = token.object;
  if ( !object || (canvas.scene !== token.parent) ) return { ok: false, reason: "GMNotViewing" };
  const delta = DIRECTIONS[direction];
  if ( !delta ) return { ok: false, reason: "Error" };

  const source = token._source;
  const target = object._getShiftedPosition(delta[0], delta[1], 0);
  // En cuadrículas sin diagonales la posición no cambia.
  if ( isSamePosition(target, source) ) return { ok: false, reason: "NoDiagonal" };

  const center = token.getCenterPoint(target);
  if ( !canvas.dimensions.rect.contains(center.x, center.y) ) return { ok: false, reason: "Wall" };
  const action = token.movementAction;
  const wallType = CONFIG.Token.movement.actions[action]?.walls;
  if ( wallType && object.checkCollision(center, { type: wallType, mode: "any" }) ) return { ok: false, reason: "Wall" };

  // Camino del tramo: si el DM movió la ficha a mano desde el último paso, se anota como salto.
  const { key, path } = getMovementState(token);
  const here = { x: source.x, y: source.y, elevation: source.elevation };
  const last = path.at(-1);
  const newPath = [...path];
  if ( !last ) newPath.push({ ...here, action });
  else if ( !isSamePosition(last, here) ) newPath.push({ ...here, action: "displace" });

  const moved = await token.move({
    x: target.x, y: target.y, elevation: source.elevation, action,
    snapped: !token.parent.grid.isGridless, explicit: false, checkpoint: true
  }, { method: "keyboard" });
  if ( !moved ) return { ok: false, reason: "Wall" };

  const now = token._source;
  newPath.push({ x: now.x, y: now.y, elevation: now.elevation, action });
  await token.setFlag(MODULE_ID, MOVE_FLAG, { key, path: newPath });
  announceFollow(token);
  return { ok: true };
}

/**
 * Devuelve la ficha a la casilla anterior (sin contar pies) y quita el paso del conteo.
 * @param {TokenDocument} token
 */
async function undoStep(token) {
  if ( !canUndoMovement(token) ) return { ok: false, reason: "NothingToUndo" };
  const { key, path } = getMovementState(token);
  const previous = path.at(-2);
  // "displace" es el movimiento de Foundry sin animación ni paredes: vuelve por donde vino.
  const moved = await token.move({
    x: previous.x, y: previous.y, elevation: previous.elevation, action: "displace"
  }, { method: "api" });
  if ( !moved ) return { ok: false, reason: "Error" };
  await token.setFlag(MODULE_ID, MOVE_FLAG, { key, path: path.slice(0, -1) });
  announceFollow(token);
  return { ok: true };
}

/**
 * Pone a cero el conteo fuera de combate (en combate se reinicia solo al empezar el turno).
 * @param {TokenDocument} token
 */
async function resetMovement(token) {
  const { key } = getMovementState(token);
  if ( key !== "free" ) return { ok: false, reason: "Error" };
  await token.setFlag(MODULE_ID, MOVE_FLAG, { key, path: [] });
  return { ok: true };
}

/* -------------------------------------------- */
/*  Seguir la ficha en la TV                    */
/* -------------------------------------------- */

/**
 * Avisa a todas las pantallas (y a esta misma) de que una ficha se movió desde un teléfono.
 * @param {TokenDocument} token
 */
function announceFollow(token) {
  const data = { type: "follow", sceneId: token.parent.id, tokenId: token.id };
  game.socket.emit(SOCKET, data);
  followToken(data.sceneId, data.tokenId);
}

/**
 * Centra el mapa en la ficha, si este cliente tiene el mapa de esa escena y el ajuste activado.
 * @param {string} sceneId
 * @param {string} tokenId
 */
function followToken(sceneId, tokenId) {
  if ( isMobileView() ) return;   // el mapa del teléfono está oculto
  if ( !canvas?.ready || (canvas.scene?.id !== sceneId) ) return;
  if ( !game.settings.get(MODULE_ID, "followMoves") ) return;
  const token = canvas.tokens.get(tokenId);
  if ( !token?.visible ) return;
  const { x, y } = token.document.getCenterPoint(token.document._source);
  canvas.animatePan({ x, y, duration: 400 });
}
