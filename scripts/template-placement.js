/**
 * Colocar el área de un hechizo desde el teléfono (con Midi QOL).
 *
 * El jugador coloca el área **antes** de que empiece el uso de Midi: así, si cancela, no se gasta nada
 * (dnd5e gasta el espacio antes de colocar el área), y Midi no se queda esperando (da 90 s a cada uso).
 * 1. El teléfono pide al DM empezar (`templateStart`). El DM prepara el área con dnd5e
 *    (`AbilityTemplate.fromActivity`, con el nivel elegido), la pone frente a la ficha del personaje y la dibuja
 *    como vista previa (sin crear el documento) en su mapa y en el de la TV (mensaje `templatePreview`).
 * 2. Cada toque de la cruceta o de girar (`templateMove`) mueve la vista previa una casilla o 15°. No puede pasar
 *    del alcance de la actividad (`activity.range`); con alcance "Self" sale de la ficha y solo se gira.
 *    El DM devuelve quién queda dentro: las fichas que ocupan alguna casilla que Foundry resalta para el área.
 * 3. Confirmar (`templateEnd`) devuelve la posición; el teléfono pide entonces el uso de Midi con esa posición
 *    y el DM coloca el área ahí (mobile-templates.js, `patchGmTemplatePlacement`). Midi sigue como siempre.
 *    Cancelar solo quita la vista previa.
 * 4. Si pasan 60 s, el DM ve un aviso con "Colocarla yo": la coloca con el ratón y la posición va al teléfono.
 */

import { MODULE_ID } from "./constants.js";
import { getSocket, registerSocketHandler } from "./remote-socket.js";
import { getScaledActivity, getScaling } from "./quick-actions.js";

const SOCKET = `module.${MODULE_ID}`;

/** Cuánto espera el DM (ms) antes de ofrecer colocar él el área. */
const GM_HELP_MS = 60 * 1000;

/** Grados que gira cada toque. */
export const ROTATE_STEP = 15;

/**
 * Sesiones de colocación abiertas en el DM.
 * @type {Map<string, object>}
 */
const sessions = new Map();

/**
 * Vistas previas dibujadas en este cliente (DM y TV), por sesión.
 * @type {Map<string, MeasuredTemplate>}
 */
const previews = new Map();

/**
 * Colocación que espera el teléfono: el DM puede terminarla él.
 * @type {{sessionId: string, resolve: Function}|null}
 */
let waiting = null;

/**
 * Registra las funciones del canal. Llamar al cargar el módulo (antes de "init").
 */
export function registerTemplatePlacement() {
  registerSocketHandler("templateStart", gmStart);
  registerSocketHandler("templateMove", gmMove);
  registerSocketHandler("templateEnd", gmEnd);
  registerSocketHandler("templateGmPlaced", onGmPlaced);
  Hooks.once("ready", () => {
    game.socket.on(SOCKET, data => {
      if ( data?.type === "templatePreview" ) drawPreview(data.sessionId, data.sceneId, data.data);
    });
    if ( !game.user.isGM ) return;
    // Si el jugador se desconecta, su vista previa se quita.
    Hooks.on("userConnected", (user, connected) => {
      if ( connected ) return;
      for ( const [id, session] of sessions ) {
        if ( session.userId === user.id ) closeSession(id);
      }
    });
  });
}

/**
 * ¿Esta actividad pide colocar un área? Como dnd5e (`create.measuredTemplate`: tiene área y `target.prompt`),
 * salvo lo que Midi coloca solo (`activityHasAutoPlaceTemplate`: radio con alcance "Self"; y emanaciones sin
 * plantilla).
 * @param {Activity} activity
 * @returns {boolean}
 */
export function needsAreaPlacement(activity) {
  const target = activity?.target;
  const type = target?.template?.type;
  if ( !type || (target.prompt === false) ) return false;
  if ( !dnd5e.config.areaTargetTypes?.[type]?.template ) return false;
  if ( type === "emanationNoTemplate" ) return false;
  const selfRange = ["self", undefined, ""].includes(activity.range?.units);
  return !(selfRange && ["radius", "squareRadius"].includes(type));
}

/* -------------------------------------------- */
/*  Lado del teléfono                           */
/* -------------------------------------------- */

/**
 * Pide al DM empezar a colocar el área.
 * @param {Activity} activity
 * @param {string|null} slot
 * @returns {Promise<object>}  `{ ok, sessionId, ...estado }` o `{ ok: false, reason }`.
 */
export async function requestPlacementStart(activity, slot) {
  if ( !getSocket() ) return { ok: false, reason: "NoSocketlib" };
  if ( !game.users.activeGM ) return { ok: false, reason: "NoGM" };
  try {
    return await getSocket().executeAsGM("templateStart", {
      actorUuid: activity.actor.uuid,
      itemId: activity.item.id,
      activityId: activity.id,
      slot,
      sceneId: game.scenes.active?.id ?? null
    });
  } catch(err) {
    return { ok: false, reason: "Error", error: err?.message ?? String(err) };
  }
}

/**
 * Mueve (una casilla) o gira la vista previa.
 * @param {string} sessionId
 * @param {{dx?: number, dy?: number, rotate?: number}} change
 * @returns {Promise<object>}  Nuevo estado (con `blocked` si chocó con el alcance o el borde).
 */
export async function requestPlacementMove(sessionId, change) {
  try {
    return await getSocket().executeAsGM("templateMove", { sessionId, ...change });
  } catch(err) {
    return { ok: false, reason: "Error", error: err?.message ?? String(err) };
  }
}

/**
 * Termina la colocación: confirmar devuelve la posición; cancelar solo quita la vista previa.
 * @param {string} sessionId
 * @param {boolean} confirm
 * @returns {Promise<{ok: boolean, x?: number, y?: number, direction?: number}>}
 */
export async function requestPlacementEnd(sessionId, confirm) {
  try {
    return await getSocket().executeAsGM("templateEnd", { sessionId, confirm });
  } catch(err) {
    return { ok: false, reason: "Error", error: err?.message ?? String(err) };
  }
}

/**
 * El teléfono espera la colocación de esta sesión: si el DM la coloca él, se avisa aquí.
 * @param {string} sessionId
 * @param {Function} resolve  Recibe `{ x, y, direction }`.
 */
export function waitForGmPlacement(sessionId, resolve) {
  waiting = sessionId ? { sessionId, resolve } : null;
}

/**
 * El DM colocó él el área (pasó el minuto).
 * @param {{sessionId: string, x: number, y: number, direction: number}} data
 */
function onGmPlaced(data) {
  if ( waiting?.sessionId !== data?.sessionId ) return false;
  const { resolve } = waiting;
  waiting = null;
  resolve(data);
  return true;
}

/* -------------------------------------------- */
/*  Lado del DM                                 */
/* -------------------------------------------- */

/**
 * @this {{socketdata: {userId: string}}}
 * @param {object} data
 */
async function gmStart({ actorUuid, itemId, activityId, slot, sceneId }) {
  const userId = this?.socketdata?.userId;
  const user = game.users.get(userId);
  const actor = fromUuidSync(actorUuid);
  const activity = actor?.items?.get(itemId)?.system.activities?.get(activityId);
  const tag = `BHD Companion | [${user?.name ?? userId}] Área de ${activity?.item?.name ?? itemId}`;
  if ( !user || !actor?.testUserPermission(user, "OWNER") || !activity ) return { ok: false, reason: "NotOwner" };
  const scene = game.scenes.get(sceneId) ?? game.scenes.active;
  if ( !canvas?.ready || (canvas.scene !== scene) ) {
    console.warn(`${tag} | El DM no está viendo la escena de la TV`);
    return { ok: false, reason: "GMNotViewing" };
  }
  const token = scene.tokens.find(t => (t.actor === actor) || (t.actorLink && (t.actorId === actor.id)));
  if ( !token ) return { ok: false, reason: "NoToken" };

  // El área tal como la prepara dnd5e, con el nivel elegido (algunas crecen con el nivel).
  const scaled = getScaledActivity(activity, getScaling(activity, slot));
  const created = dnd5e.canvas.AbilityTemplate.fromActivity(scaled) ?? [];
  const data = created[0]?.document?.toObject();
  if ( !data ) return { ok: false, reason: "NoArea" };
  data.user = user.id;
  data.fillColor = user.color?.css ?? user.color ?? data.fillColor;

  const range = getRange(activity);
  const canRotate = ["cone", "ray"].includes(data.t);
  const facing = (((token.rotation ?? 0) + 90) % 360);
  const session = {
    id: foundry.utils.randomID(),
    userId: user.id,
    userName: user.name,
    activity: scaled,
    itemName: activity.item.name,
    token,
    scene,
    data,
    range,
    canRotate,
    self: range.self,
    timer: null,
    dialog: null
  };
  if ( canRotate ) data.direction = facing;
  Object.assign(data, startPoint(session, facing));
  sessions.set(session.id, session);
  session.timer = setTimeout(() => offerGmHelp(session.id), GM_HELP_MS);
  console.log(`${tag} | 1. Vista previa (${data.t}, ${data.distance} ${scene.grid.units}, alcance ${range.label})`);
  await showPreview(session);
  return { ok: true, sessionId: session.id, ...(await getState(session)) };
}

/**
 * @this {{socketdata: {userId: string}}}
 * @param {{sessionId: string, dx?: number, dy?: number, rotate?: number}} data
 */
async function gmMove({ sessionId, dx=0, dy=0, rotate=0 }) {
  const session = sessions.get(sessionId);
  if ( !session || (session.userId !== this?.socketdata?.userId) ) return { ok: false, reason: "Expired" };
  const data = session.data;
  let blocked = false;
  if ( rotate && session.canRotate ) {
    data.direction = (((data.direction + rotate) % 360) + 360) % 360;
    if ( session.self ) Object.assign(data, startPoint(session, data.direction));
  }
  if ( (dx || dy) && !session.self ) {
    const grid = session.scene.grid;
    const point = { x: data.x + (Math.sign(dx) * grid.sizeX), y: data.y + (Math.sign(dy) * grid.sizeY) };
    if ( isAllowed(session, point) ) Object.assign(data, point);
    else blocked = true;
  }
  if ( !blocked ) await showPreview(session);
  return { ok: true, blocked, ...(await getState(session)) };
}

/**
 * @this {{socketdata: {userId: string}}}
 * @param {{sessionId: string, confirm: boolean}} data
 */
async function gmEnd({ sessionId, confirm }) {
  const session = sessions.get(sessionId);
  if ( !session || (session.userId !== this?.socketdata?.userId) ) return { ok: false, reason: "Expired" };
  const { x, y, direction } = session.data;
  console.log(`BHD Companion | [${session.userName}] Área de ${session.itemName} | 2. ${confirm ? "Confirmada" : "Cancelada"}`,
    confirm ? { x, y, direction } : "");
  closeSession(sessionId);
  return confirm ? { ok: true, x, y, direction } : { ok: true };
}

/**
 * Quita la sesión, su vista previa (aquí y en la TV) y el aviso del DM.
 * @param {string} sessionId
 */
function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if ( !session ) return;
  sessions.delete(sessionId);
  clearTimeout(session.timer);
  session.dialog?.close().catch(() => {});
  drawPreview(sessionId, session.scene.id, null);
  game.socket.emit(SOCKET, { type: "templatePreview", sessionId, sceneId: session.scene.id, data: null });
}

/**
 * Alcance de la actividad en unidades de la escena, leído de dnd5e (`activity.range`).
 * @param {Activity} activity
 * @returns {{self: boolean, max: number, label: string}}  `max` = Infinity si no tiene límite.
 */
function getRange(activity) {
  const { units, value } = activity.range ?? {};
  const label = activity.labels?.range ?? "";
  if ( ["self", undefined, ""].includes(units) ) return { self: true, max: 0, label };
  const sceneUnits = canvas.scene.grid.units;
  if ( units === "touch" ) return { self: false, max: canvas.scene.grid.distance, label };
  const number = Number(value);
  if ( !Number.isFinite(number) || !(number > 0) ) return { self: false, max: Infinity, label };
  let max = number;
  if ( (units !== sceneUnits) && (typeof dnd5e.utils.convertLength === "function") ) {
    try {
      max = dnd5e.utils.convertLength(number, units, sceneUnits);
    } catch(err) {
      console.warn("BHD Companion | No se pudo convertir el alcance", err);
    }
  }
  return { self: false, max, label };
}

/**
 * Primera posición: con alcance "Self", en el borde de la ficha hacia donde mira; si no, en la casilla de
 * enfrente (o en la ficha si eso queda fuera del alcance).
 * @param {object} session
 * @param {number} direction  Grados (0 = derecha, 90 = abajo).
 * @returns {{x: number, y: number}}
 */
function startPoint(session, direction) {
  const grid = session.scene.grid;
  const center = session.token.getCenterPoint();
  const radians = Math.toRadians(direction);
  const half = (session.token.width * grid.sizeX) / 2;
  if ( session.self ) {
    if ( !session.canRotate ) return center;
    return { x: center.x + (Math.cos(radians) * half), y: center.y + (Math.sin(radians) * half) };
  }
  const ahead = { x: center.x + (Math.cos(radians) * (half + grid.sizeX)), y: center.y + (Math.sin(radians) * (half + grid.sizeY)) };
  const point = grid.isGridless ? ahead : grid.getCenterPoint(grid.getOffset(ahead));
  return isAllowed(session, point) ? point : center;
}

/**
 * ¿Puede ir el área aquí? Dentro de la escena y sin pasar del alcance, medido desde el borde de la ficha
 * con la regla de distancias de la escena.
 * @param {object} session
 * @param {{x: number, y: number}} point
 */
function isAllowed(session, point) {
  const rect = session.scene.dimensions.sceneRect;
  if ( (point.x < rect.x) || (point.y < rect.y) || (point.x > rect.right) || (point.y > rect.bottom) ) return false;
  if ( !Number.isFinite(session.range.max) ) return true;
  const grid = session.scene.grid;
  const distance = grid.measurePath([session.token.getCenterPoint(), point]).distance;
  const reach = session.range.max + ((session.token.width * grid.distance) / 2);
  return distance <= reach + 0.001;
}

/**
 * Lo que ve el teléfono: posición, si se puede mover / girar, alcance y quién queda dentro.
 * @param {object} session
 */
async function getState(session) {
  const { x, y, direction, t } = session.data;
  return {
    x, y, direction, shape: t,
    canMove: !session.self,
    canRotate: session.canRotate,
    range: session.range.label,
    inside: getInside(session)
  };
}

/**
 * Criaturas dentro del área: fichas visibles que ocupan alguna casilla que Foundry resalta para la vista previa
 * (sin cuadrícula: el centro de la ficha dentro de la forma). Aliado / enemigo según la disposición de su ficha
 * respecto a la del lanzador. Midi decide los objetivos finales al confirmar.
 * @param {object} session
 * @returns {{name: string, side: string}[]}
 */
function getInside(session) {
  const preview = previews.get(session.id);
  if ( !preview ) return [];
  const grid = session.scene.grid;
  const key = offset => `${offset.i},${offset.j}`;
  let cells = null;
  try {
    if ( !grid.isGridless ) {
      cells = new Set((preview._getGridHighlightPositions?.() ?? [])
        .map(p => key(grid.getOffset({ x: p.x + (grid.sizeX / 2), y: p.y + (grid.sizeY / 2) }))));
    }
  } catch(err) {
    console.warn("BHD Companion | No se pudieron leer las casillas del área", err);
  }
  const D = CONST.TOKEN_DISPOSITIONS;
  const caster = session.token.disposition;
  const inside = [];
  for ( const token of session.scene.tokens ) {
    if ( token.hidden || !token.actor ) continue;
    let hit;
    if ( cells?.size ) {
      const offsets = token.getOccupiedGridSpaceOffsets?.() ?? [grid.getOffset(token.getCenterPoint())];
      hit = offsets.some(o => cells.has(key(o)));
    } else {
      const c = token.getCenterPoint();
      hit = !!preview.shape?.contains(c.x - preview.document.x, c.y - preview.document.y);
    }
    if ( !hit ) continue;
    let side = "neutral";
    if ( token === session.token ) side = "self";
    else if ( token.disposition === D.SECRET ) side = "unknown";
    else if ( token.disposition === caster ) side = "ally";
    else if ( (token.disposition * caster) < 0 ) side = "enemy";
    inside.push({ name: (side === "unknown") ? "" : token.name, side });
  }
  return inside;
}

/**
 * Dibuja la vista previa aquí (DM) y la manda a las demás pantallas (TV).
 * @param {object} session
 */
async function showPreview(session) {
  await drawPreview(session.id, session.scene.id, session.data);
  game.socket.emit(SOCKET, { type: "templatePreview", sessionId: session.id, sceneId: session.scene.id, data: session.data });
}

/**
 * Vista previa en este cliente (con mapa), como la que dibuja dnd5e al colocar un área con el ratón:
 * un MeasuredTemplate sin documento guardado, en `canvas.templates.preview`. Sin datos, se quita.
 * @param {string} sessionId
 * @param {string} sceneId
 * @param {object|null} data
 */
async function drawPreview(sessionId, sceneId, data) {
  const old = previews.get(sessionId);
  if ( old ) {
    previews.delete(sessionId);
    old.parent?.removeChild(old);
    old.destroy({ children: true });
  }
  if ( !data || !canvas?.ready || (canvas.scene?.id !== sceneId) ) return;
  try {
    const document = new CONFIG.MeasuredTemplate.documentClass(foundry.utils.deepClone(data), { parent: canvas.scene });
    const object = new CONFIG.MeasuredTemplate.objectClass(document);
    previews.set(sessionId, object);
    await object.draw();
    canvas.templates.preview.addChild(object);
    object.renderFlags?.set({ refresh: true });
    object.applyRenderFlags?.();
  } catch(err) {
    console.error("BHD Companion | No se pudo dibujar la vista previa del área", err);
  }
}

/**
 * Pasó un minuto: el DM puede colocar él el área (con el ratón, como siempre); la posición va al teléfono.
 * @param {string} sessionId
 */
function offerGmHelp(sessionId) {
  const session = sessions.get(sessionId);
  if ( !session || !session.scene.tokens.has(session.token.id) ) return;
  console.log(`BHD Companion | [${session.userName}] Área de ${session.itemName} | Lleva un minuto: aviso al DM`);
  const { DialogV2 } = foundry.applications.api;
  const escape = foundry.utils.escapeHTML;
  session.dialog = new DialogV2({
    window: { title: "BHD.Place.GMTitle" },
    content: `<p>${escape(game.i18n.format("BHD.Place.GMContent", { user: session.userName, name: session.itemName }))}</p>`,
    buttons: [
      { action: "place", label: "BHD.Place.GMPlace", icon: "fa-solid fa-hand-pointer", default: true,
        callback: () => gmPlaceSelf(sessionId) },
      { action: "wait", label: "BHD.Place.GMWait", icon: "fa-solid fa-hourglass-half" }
    ]
  });
  session.dialog.render({ force: true });
}

/**
 * El DM coloca el área con el ratón. dnd5e la crearía al hacer clic: se toma su posición y no se crea (la crea
 * el uso de Midi, como si la hubiera colocado el jugador).
 * @param {string} sessionId
 */
async function gmPlaceSelf(sessionId) {
  const session = sessions.get(sessionId);
  if ( !session ) return;
  session.dialog = null;
  clearTimeout(session.timer);
  drawPreview(sessionId, session.scene.id, null);
  game.socket.emit(SOCKET, { type: "templatePreview", sessionId, sceneId: session.scene.id, data: null });
  const [template] = dnd5e.canvas.AbilityTemplate.fromActivity(session.activity) ?? [];
  if ( !template ) return;
  let placed = null;
  const hookId = Hooks.on("preCreateMeasuredTemplate", (document, data) => {
    if ( foundry.utils.getProperty(data, "flags.dnd5e.origin") !== session.activity.uuid ) return;
    placed = { x: data.x, y: data.y, direction: data.direction };
    return false;
  });
  try {
    await template.drawPreview();
  } catch(err) {
    // El DM canceló con el botón derecho: el jugador sigue colocándola.
  } finally {
    Hooks.off("preCreateMeasuredTemplate", hookId);
  }
  if ( !sessions.has(sessionId) ) return;
  if ( !placed ) {
    await showPreview(session);
    return;
  }
  Object.assign(session.data, placed);
  console.log(`BHD Companion | [${session.userName}] Área de ${session.itemName} | 2. La colocó el DM`, placed);
  closeSession(sessionId);
  try {
    await getSocket().executeAsUser("templateGmPlaced", session.userId, { sessionId, ...placed });
  } catch(err) {
    console.warn("BHD Companion | No se pudo avisar al teléfono de que el DM colocó el área", err);
  }
}
