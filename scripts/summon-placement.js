/**
 * Colocar invocaciones desde el teléfono con la cruceta (como "Colocar área").
 *
 * Cómo se colocan hoy (código de dnd5e 5.3, Midi QOL 13.0 y Cauldron / chris-premades 1.5):
 * - **Actividad Invocar de dnd5e** (`SummonActivity`): `use()` gasta primero (espacio, usos) y después, en
 *   `_finalizeUsage`, llama a `placeSummons` → `getPlacement` → `TokenPlacement.place` (el jugador hace clic en el
 *   mapa con el ratón, una criatura tras otra). Midi (`MidiSummonActivity#getPlacement`) acepta posiciones ya
 *   decididas en `summons.placements`. Con la vista móvil y Midi, el uso lo ejecuta el DM (midi-remote.js), así que
 *   la colocación pasaría en su PC.
 * - **Cauldron** (`Summons.spawn`, p. ej. Find Familiar, Wildfire Spirit de sus macros): por cada criatura llama a
 *   `crosshairUtils.aimCrosshair({ token, maxRange, crosshairsConfig })`, que dibuja una mirilla en el cliente del
 *   flujo (el DM) y devuelve el centro elegido `{ x, y, direction, cancelled }`. El alcance es `options.range`.
 *   La misma función sirve para teletransportes (Misty Step).
 *
 * Qué se hace:
 * - **dnd5e**: como dnd5e gasta antes de colocar, el jugador coloca **antes** del uso (igual que las áreas):
 *   elige la criatura (si hay varias), el DM abre una sesión con la vista previa de la ficha (en su PC y en la TV),
 *   el teléfono la mueve casilla a casilla y confirma una criatura tras otra. Luego se pide el uso con esas
 *   posiciones; `patchTokenPlacement` (mobile-templates.js) las usa en lugar del clic. Cancelar = no se pide nada.
 * - **Cauldron**: en el DM, durante un uso del teléfono, `aimCrosshair` abre la misma sesión y la manda al teléfono
 *   (`summonAim`). Lo elegido vuelve a Cauldron con el formato de su mirilla. Aquí el uso ya empezó: cancelar
 *   devuelve `cancelled` a Cauldron (no invoca), pero lo gastado lo decide Cauldron.
 *
 * Reglas al mover: dentro de la escena, sin pasar del alcance (de la actividad o el `maxRange` de Cauldron, medido
 * desde la ficha del personaje) y sin cruzar paredes de movimiento desde el personaje. No se confirma encima de
 * otra ficha ni de una criatura ya colocada.
 */

import { MODULE_ID } from "./constants.js";
import { askPhone, getActiveRemoteRun, getRemoteRunFor, RELAY_NO_ANSWER } from "./dialog-relay.js";
import { callGM, registerSocketHandler } from "./remote-socket.js";
import { getScaledActivity, getScaling } from "./quick-actions.js";
import { showDecision } from "./decisions.js";

const SOCKET = `module.${MODULE_ID}`;

/** Cuánto espera el teléfono cada respuesta del DM (ms). */
const TIMEOUT_MS = 10 * 1000;

/** Máximo de criaturas que se colocan a mano (el resto, solas junto al personaje). */
const MAX_MANUAL = 12;

/** Sesiones abiertas en el DM. @type {Map<string, object>} */
const sessions = new Map();

/** Vistas previas dibujadas en este cliente (DM y TV), por sesión: lista de fichas de vista previa. */
const previews = new Map();

/**
 * Posiciones elegidas en el teléfono para un uso sin Midi (el teléfono ejecuta el uso): las toma
 * `patchTokenPlacement` en este mismo cliente.
 * @type {{activityUuid: string, placements: object[]}|null}
 */
let pendingLocal = null;

/**
 * Registra las funciones del canal. Llamar al cargar el módulo (antes de "init").
 */
export function registerSummonPlacement() {
  registerSocketHandler("summonStart", gmStart);
  registerSocketHandler("summonMove", gmMove);
  registerSocketHandler("summonEnd", gmEnd);
  registerSocketHandler("summonAim", phoneAim);
  Hooks.once("ready", () => {
    game.socket.on(SOCKET, data => {
      if ( data?.type === "summonPreview" ) drawPreviews(data.sessionId, data.sceneId, data.tokens);
    });
    if ( !game.user.isGM ) return;
    patchCauldronAim();
    Hooks.on("userConnected", (user, connected) => {
      if ( connected ) return;
      for ( const [id, session] of sessions ) {
        if ( session.userId === user.id ) closeSession(id, null);
      }
    });
  });
}

/**
 * ¿Esta actividad invoca y dnd5e pediría colocar las criaturas con el ratón? (Modo "por VD" no: la criatura se
 * elige durante el uso, en el buscador de dnd5e; esas se colocan solas junto al personaje.)
 * @param {Activity} activity
 * @returns {boolean}
 */
export function needsSummonPlacement(activity) {
  if ( activity?.type !== "summon" ) return false;
  if ( activity.summon?.prompt === false ) return false;
  if ( activity.summon?.mode === "cr" ) return false;
  return (activity.availableProfiles?.length ?? 0) > 0;
}

/* -------------------------------------------- */
/*  Lado del teléfono                           */
/* -------------------------------------------- */

/**
 * Elige en el teléfono la criatura, el tamaño y el tipo (solo lo que tenga más de una opción), con el aviso de
 * decisión de la vista. Lo elegido se pasa luego al uso (así dnd5e no vuelve a preguntar).
 * @param {Activity} activity
 * @returns {Promise<{profile: string, creatureSize: string|null, creatureType: string|null}|null>}  Null = cancelar.
 */
export async function chooseSummonOptions(activity) {
  const profiles = activity.availableProfiles ?? [];
  const choice = {
    profile: profiles[0]?._id ?? null,
    creatureSize: activity.creatureSizes?.first?.() ?? null,
    creatureType: activity.creatureTypes?.first?.() ?? null
  };
  const ask = async (title, options) => {
    const answer = await showDecision({
      kind: "summon", title, img: activity.item.img,
      buttons: options.map(o => ({ label: o.label, value: o.value, img: o.img, style: "choice" })),
      closable: true, closeValue: null
    }).promise;
    return answer ?? null;
  };
  if ( profiles.length > 1 ) {
    const options = profiles.map(p => {
      const source = p.uuid ? fromUuidSync(p.uuid) : null;
      return { value: p._id, label: p.name || source?.name || "?", img: source?.img };
    });
    choice.profile = await ask(game.i18n.format("BHD.Summon.ChooseCreature", { name: activity.item.name }), options);
    if ( !choice.profile ) return null;
  }
  const sizes = Array.from(activity.creatureSizes ?? []);
  if ( sizes.length > 1 ) {
    choice.creatureSize = await ask(game.i18n.localize("BHD.Summon.ChooseSize"),
      sizes.map(s => ({ value: s, label: CONFIG.DND5E.actorSizes[s]?.label ?? s })));
    if ( !choice.creatureSize ) return null;
  }
  const types = Array.from(activity.creatureTypes ?? []);
  if ( types.length > 1 ) {
    choice.creatureType = await ask(game.i18n.localize("BHD.Summon.ChooseType"),
      types.map(t => ({ value: t, label: CONFIG.DND5E.creatureTypes[t]?.label ?? t })));
    if ( !choice.creatureType ) return null;
  }
  console.log(`BHD Companion | Invocar ${activity.item.name}: elegido`, choice);
  return choice;
}

/**
 * Pide al DM empezar a colocar las criaturas de una actividad Invocar de dnd5e.
 * @param {Activity} activity
 * @param {string|null} slot
 * @param {object} choice  De `chooseSummonOptions`.
 * @returns {Promise<object>}  `{ ok, sessionId, ...estado }` o `{ ok: false, reason }`.
 */
export function requestSummonStart(activity, slot, choice) {
  return callGM("summonStart", {
    actorUuid: activity.actor.uuid,
    itemId: activity.item.id,
    activityId: activity.id,
    slot,
    ...choice,
    sceneId: game.scenes.active?.id ?? null
  }, TIMEOUT_MS);
}

/**
 * Mueve la criatura que se está colocando una casilla.
 * @param {string} sessionId
 * @param {{dx?: number, dy?: number}} change
 */
export function requestSummonMove(sessionId, change) {
  return callGM("summonMove", { sessionId, ...change }, TIMEOUT_MS);
}

/**
 * Confirma la criatura actual (pasa a la siguiente o termina) o cancela todo.
 * @param {string} sessionId
 * @param {boolean} confirm
 * @returns {Promise<object>}  `{ ok, done, placements?, ...estado }`.
 */
export function requestSummonEnd(sessionId, confirm) {
  return callGM("summonEnd", { sessionId, confirm }, TIMEOUT_MS);
}

/**
 * Sin Midi (el teléfono ejecuta el uso): guarda las posiciones para la próxima colocación de esta actividad.
 * @param {Activity|null} activity
 * @param {object[]|null} placements
 */
export function setLocalSummonPlacements(activity, placements) {
  pendingLocal = (activity && placements?.length) ? { activityUuid: activity.uuid, placements } : null;
}

/**
 * Posiciones elegidas para la colocación que pide dnd5e (`TokenPlacement.place`), o null. En el DM: las del uso
 * remoto de ese personaje; en el teléfono (sin Midi): las guardadas con `setLocalSummonPlacements`.
 * @param {object} config  `{ origin: TokenDocument, tokens: PrototypeToken[] }`.
 * @returns {object[]|null}
 */
export function takeSummonPlacements(config) {
  const actor = config?.origin?.actor;
  if ( game.user.isGM ) {
    const run = getRemoteRunFor(actor);
    const placements = run?.summon?.placements;
    if ( !placements?.length ) return null;
    run.summon.placements = null;   // una sola vez por uso
    return placements;
  }
  if ( !pendingLocal ) return null;
  const { placements } = pendingLocal;
  pendingLocal = null;
  return placements;
}

/**
 * Teléfono: el DM pide colocar algo de Cauldron (invocación o teletransporte) durante un uso.
 * @param {object} data  `{ sessionId, title, img, state }`.
 * @returns {Promise<object>}  `{ ok, cancelled?, x?, y?, direction? }`.
 */
async function phoneAim(data) {
  const app = game.modules.get(MODULE_ID)?.api?.app;
  console.log(`BHD Companion | El DM pide colocar en el teléfono: ${data?.title}`, data?.state);
  if ( typeof app?.placeFromGM !== "function" ) return { ok: false, reason: "NoMobileView" };
  return app.placeFromGM(data);
}

/* -------------------------------------------- */
/*  Lado del DM                                 */
/* -------------------------------------------- */

/**
 * Ficha del personaje en la escena.
 * @param {Scene} scene
 * @param {Actor} actor
 */
function findToken(scene, actor) {
  return scene?.tokens.find(t => (t.actor === actor) || (t.actorLink && (t.actorId === actor.id))) ?? null;
}

/**
 * @this {{socketdata: {userId: string}}}
 * @param {object} data
 */
async function gmStart({ actorUuid, itemId, activityId, slot, profile, creatureSize, sceneId }) {
  const user = game.users.get(this?.socketdata?.userId);
  const actor = fromUuidSync(actorUuid);
  const activity = actor?.items?.get(itemId)?.system.activities?.get(activityId);
  const tag = `BHD Companion | [${user?.name ?? "?"}] Invocar ${activity?.item?.name ?? itemId}`;
  if ( !user || !actor?.testUserPermission(user, "OWNER") || !activity ) return { ok: false, reason: "NotOwner" };
  const scene = game.scenes.get(sceneId) ?? game.scenes.active;
  if ( !canvas?.ready || (canvas.scene !== scene) ) {
    console.warn(`${tag} | El DM no está viendo la escena de la TV`);
    return { ok: false, reason: "GMNotViewing" };
  }
  const token = findToken(scene, actor);
  if ( !token ) return { ok: false, reason: "NoToken" };

  // La criatura y cuántas, como dnd5e (`getPlacement`): fórmula `count` con los datos del nivel elegido.
  const scaled = getScaledActivity(activity, getScaling(activity, slot));
  const chosen = scaled.availableProfiles.find(p => p._id === profile) ?? scaled.availableProfiles[0];
  if ( !chosen?.uuid ) return { ok: false, reason: "NoCreature" };
  const source = await fromUuid(chosen.uuid);
  const prototype = source?.prototypeToken;
  if ( !prototype ) return { ok: false, reason: "NoCreature" };
  let width = prototype.width ?? 1;
  let height = prototype.height ?? 1;
  const sizeConfig = (scaled.creatureSizes?.size && creatureSize) ? CONFIG.DND5E.actorSizes[creatureSize] : null;
  if ( sizeConfig ) width = height = sizeConfig.token ?? 1;
  let count = 1;
  try {
    const roll = await new Roll(chosen.count || "1", scaled.getRollData()).evaluate();
    count = Math.clamp(parseInt(roll.total) || 1, 1, MAX_MANUAL);
  } catch(err) {
    console.warn(`${tag} | No se pudo calcular cuántas criaturas`, err);
  }
  const look = {
    name: prototype.name || source.name,
    src: (prototype.randomImg ? source.img : prototype.texture?.src) || source.img,
    width, height
  };
  const session = createSession({
    kind: "summon", user, actor, token, scene,
    label: activity.item.name,
    range: getRange(scaled, scene),
    looks: Array(count).fill(look)
  });
  console.log(`${tag} | 1. Vista previa: ${count} × ${look.name} (alcance ${session.range.label || "∞"})`);
  await showPreviews(session);
  return { ok: true, sessionId: session.id, ...getState(session) };
}

/**
 * Crea una sesión con su primera posición.
 * @param {object} data
 * @returns {object}
 */
function createSession({ kind, user, actor, token, scene, label, range, looks, resolve=null }) {
  const session = {
    id: foundry.utils.randomID(),
    kind, userId: user.id, userName: user.name, actor, token, scene, label, range, looks,
    index: 0, placements: [], current: null, resolve
  };
  session.current = findStart(session);
  sessions.set(session.id, session);
  return session;
}

/**
 * @this {{socketdata: {userId: string}}}
 * @param {{sessionId: string, dx?: number, dy?: number}} data
 */
async function gmMove({ sessionId, dx=0, dy=0 }) {
  const session = sessions.get(sessionId);
  if ( !session || (session.userId !== this?.socketdata?.userId) ) return { ok: false, reason: "Expired" };
  const grid = session.scene.grid;
  const point = { x: session.current.x + (Math.sign(dx) * grid.sizeX), y: session.current.y + (Math.sign(dy) * grid.sizeY) };
  const reason = getMoveBlock(session, point);
  if ( !reason ) {
    session.current = point;
    await showPreviews(session);
  }
  return { ok: true, blocked: !!reason, blockReason: reason, ...getState(session) };
}

/**
 * @this {{socketdata: {userId: string}}}
 * @param {{sessionId: string, confirm: boolean}} data
 */
async function gmEnd({ sessionId, confirm }) {
  const session = sessions.get(sessionId);
  if ( !session || (session.userId !== this?.socketdata?.userId) ) return { ok: false, reason: "Expired" };
  const tag = `BHD Companion | [${session.userName}] Invocar ${session.label}`;
  if ( !confirm ) {
    console.log(`${tag} | Cancelado`);
    closeSession(sessionId, null);
    return { ok: true, done: true, cancelled: true };
  }
  if ( isOccupied(session, session.current) ) {
    return { ok: true, done: false, blocked: true, blockReason: "Occupied", ...getState(session) };
  }
  const look = session.looks[session.index];
  session.placements.push({ x: session.current.x, y: session.current.y, rotation: 0, width: look.width, height: look.height });
  console.log(`${tag} | 2. Criatura ${session.index + 1}/${session.looks.length} en`, session.current);
  if ( session.index + 1 < session.looks.length ) {
    session.index += 1;
    session.current = findStart(session);
    await showPreviews(session);
    return { ok: true, done: false, ...getState(session) };
  }
  const placements = session.placements.map(({ x, y, rotation }) => ({ x, y, rotation }));
  closeSession(sessionId, placements);
  return { ok: true, done: true, placements };
}

/**
 * Quita la sesión y su vista previa (aquí y en la TV).
 * @param {string} sessionId
 * @param {object[]|null} placements  Lo colocado (null = cancelado).
 */
function closeSession(sessionId, placements) {
  const session = sessions.get(sessionId);
  if ( !session ) return;
  sessions.delete(sessionId);
  drawPreviews(sessionId, session.scene.id, null);
  game.socket.emit(SOCKET, { type: "summonPreview", sessionId, sceneId: session.scene.id, tokens: null });
  session.resolve?.(placements);
}

/**
 * Alcance de la actividad en unidades de la escena (`activity.range` de dnd5e). "Personal" o sin alcance = al lado
 * del personaje (una casilla); sin número = sin límite.
 * @param {Activity} activity
 * @param {Scene} scene
 * @returns {{max: number, label: string}}
 */
function getRange(activity, scene) {
  const { units, value } = activity.range ?? {};
  const label = activity.labels?.range ?? "";
  const distance = scene.grid.distance;
  if ( ["self", "touch", undefined, ""].includes(units) ) return { max: distance, label };
  const number = Number(value);
  if ( !Number.isFinite(number) || !(number > 0) ) return { max: Infinity, label };
  return { max: convert(number, units, scene), label };
}

/**
 * Pasa una distancia a las unidades de la escena.
 * @param {number} number
 * @param {string} units
 * @param {Scene} scene
 */
function convert(number, units, scene) {
  const sceneUnits = scene.grid.units;
  if ( !units || (units === sceneUnits) || (typeof dnd5e.utils.convertLength !== "function") ) return number;
  try {
    return dnd5e.utils.convertLength(number, units, sceneUnits);
  } catch(err) {
    return number;
  }
}

/**
 * Caja que ocupa una ficha (esquina arriba a la izquierda y tamaño en casillas).
 * @param {object} session
 * @param {{x: number, y: number}} point
 * @param {object} [look]
 */
function boxAt(session, point, look=session.looks[session.index]) {
  const grid = session.scene.grid;
  return { x0: point.x, y0: point.y, x1: point.x + ((look.width ?? 1) * grid.sizeX), y1: point.y + ((look.height ?? 1) * grid.sizeY) };
}

/**
 * Centro de la ficha que se coloca en un punto.
 * @param {object} session
 * @param {{x: number, y: number}} point
 */
function centerAt(session, point) {
  const box = boxAt(session, point);
  return { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
}

/**
 * ¿Hay otra ficha (o una criatura ya colocada en esta sesión) en esa casilla?
 * @param {object} session
 * @param {{x: number, y: number}} point
 */
function isOccupied(session, point) {
  const grid = session.scene.grid;
  const box = boxAt(session, point);
  const overlaps = b => (box.x0 < b.x1 - 1) && (b.x0 < box.x1 - 1) && (box.y0 < b.y1 - 1) && (b.y0 < box.y1 - 1);
  for ( const token of session.scene.tokens ) {
    if ( overlaps({ x0: token.x, y0: token.y, x1: token.x + (token.width * grid.sizeX), y1: token.y + (token.height * grid.sizeY) }) ) {
      return true;
    }
  }
  return session.placements.some(p => overlaps({ x0: p.x, y0: p.y, x1: p.x + (p.width * grid.sizeX), y1: p.y + (p.height * grid.sizeY) }));
}

/**
 * Por qué no se puede mover la criatura a ese punto ("Edge", "Range", "Wall") o null si se puede.
 * Las casillas ocupadas sí se pueden cruzar (no se confirma encima).
 * @param {object} session
 * @param {{x: number, y: number}} point
 * @returns {string|null}
 */
function getMoveBlock(session, point) {
  const rect = session.scene.dimensions.sceneRect;
  const box = boxAt(session, point);
  if ( (box.x0 < rect.x) || (box.y0 < rect.y) || (box.x1 > rect.right) || (box.y1 > rect.bottom) ) return "Edge";
  const origin = session.token.getCenterPoint();
  const center = centerAt(session, point);
  if ( Number.isFinite(session.range.max) ) {
    const grid = session.scene.grid;
    const distance = grid.measurePath([origin, center]).distance;
    // Se mide de borde a borde: media ficha del personaje y media de la criatura.
    const look = session.looks[session.index];
    const reach = session.range.max + ((session.token.width * grid.distance) / 2) + (((look.width ?? 1) * grid.distance) / 2);
    if ( distance > reach + 0.001 ) return "Range";
  }
  try {
    const backend = CONFIG.Canvas.polygonBackends?.move;
    if ( backend?.testCollision(origin, center, { type: "move", mode: "any" }) ) return "Wall";
  } catch(err) {
    console.warn("BHD Companion | No se pudo comprobar las paredes", err);
  }
  return null;
}

/**
 * Primera posición de la criatura: la casilla libre más cercana al personaje (o a la última colocada) que se
 * pueda alcanzar.
 * @param {object} session
 * @returns {{x: number, y: number}}
 */
function findStart(session) {
  const grid = session.scene.grid;
  const anchor = session.placements.at(-1) ?? { x: session.token.x, y: session.token.y };
  const start = grid.getOffset({ x: anchor.x + 1, y: anchor.y + 1 });
  for ( let ring = 1; ring <= 10; ring++ ) {
    for ( let di = -ring; di <= ring; di++ ) {
      for ( let dj = -ring; dj <= ring; dj++ ) {
        if ( Math.max(Math.abs(di), Math.abs(dj)) !== ring ) continue;
        const point = grid.getTopLeftPoint({ i: start.i + di, j: start.j + dj });
        if ( !getMoveBlock(session, point) && !isOccupied(session, point) ) return point;
      }
    }
  }
  return { x: session.token.x, y: session.token.y };
}

/**
 * Lo que ve el teléfono.
 * @param {object} session
 */
function getState(session) {
  const grid = session.scene.grid;
  const origin = session.token.getCenterPoint();
  const look = session.looks[session.index];
  const edge = ((session.token.width * grid.distance) / 2) + (((look.width ?? 1) * grid.distance) / 2);
  const distance = Math.max(0, grid.measurePath([origin, centerAt(session, session.current)]).distance - edge);
  return {
    kind: session.kind,
    x: session.current.x,
    y: session.current.y,
    index: session.index,
    count: session.looks.length,
    name: look.name,
    img: look.src,
    canMove: true,
    canRotate: false,
    range: session.range.label || (Number.isFinite(session.range.max) ? `${session.range.max} ${grid.units}` : ""),
    distance: `${Math.round(distance * 10) / 10} ${grid.units}`,
    occupied: isOccupied(session, session.current)
  };
}

/**
 * Datos de las vistas previas: las criaturas ya colocadas y la que se mueve.
 * @param {object} session
 */
function previewData(session) {
  const list = session.placements.map((p, i) => ({ ...session.looks[i], x: p.x, y: p.y, alpha: 0.8 }));
  list.push({ ...session.looks[session.index], x: session.current.x, y: session.current.y, alpha: 0.55 });
  return list;
}

/**
 * Dibuja aquí (DM) y en la TV.
 * @param {object} session
 */
async function showPreviews(session) {
  const tokens = previewData(session);
  await drawPreviews(session.id, session.scene.id, tokens);
  game.socket.emit(SOCKET, { type: "summonPreview", sessionId: session.id, sceneId: session.scene.id, tokens });
}

/**
 * Vista previa en este cliente (con mapa), como la de dnd5e al invocar con el ratón: fichas sin guardar en
 * `canvas.tokens.preview`. Se reutilizan las que ya existen (solo se mueven). Sin datos, se quitan.
 * @param {string} sessionId
 * @param {string} sceneId
 * @param {object[]|null} tokens  `{ name, src, width, height, x, y, alpha }`.
 */
async function drawPreviews(sessionId, sceneId, tokens) {
  const current = previews.get(sessionId) ?? [];
  const clear = list => list.forEach(object => {
    try {
      object.parent?.removeChild(object);
      if ( !object.destroyed ) object.destroy({ children: true });
    } catch(err) {}
  });
  if ( !tokens || !canvas?.ready || (canvas.scene?.id !== sceneId) ) {
    clear(current);
    previews.delete(sessionId);
    return;
  }
  try {
    // Quitar las que sobran o cambiaron de aspecto.
    while ( current.length > tokens.length ) clear([current.pop()]);
    for ( let i = 0; i < tokens.length; i++ ) {
      const data = tokens[i];
      let object = current[i];
      if ( object && (object.document.texture.src !== data.src) ) {
        clear([object]);
        object = null;
      }
      if ( !object ) {
        const cls = getDocumentClass("Token");
        const document = new cls({
          _id: foundry.utils.randomID(), name: data.name, texture: { src: data.src },
          width: data.width, height: data.height, x: data.x, y: data.y, alpha: data.alpha,
          sight: { enabled: false }, displayName: CONST.TOKEN_DISPLAY_MODES.NONE
        }, { parent: canvas.scene });
        object = document.object ?? new CONFIG.Token.objectClass(document);
        object._previewType = "creation";
        canvas.tokens.preview.addChild(object);
        await object.draw();
        object.eventMode = "none";
        current[i] = object;
      } else {
        object.document.updateSource({ x: data.x, y: data.y, alpha: data.alpha });
        object.renderFlags?.set({ refreshPosition: true, refreshState: true });
        object.refresh?.();
      }
    }
    previews.set(sessionId, current);
  } catch(err) {
    console.error("BHD Companion | No se pudo dibujar la vista previa de la invocación", err);
  }
}

/**
 * Cauldron: durante un uso del teléfono, su mirilla (`aimCrosshair`) se coloca desde el teléfono.
 */
function patchCauldronAim() {
  const utils = globalThis.chrisPremades?.utils?.crosshairUtils;
  if ( (typeof utils?.aimCrosshair !== "function") || utils.aimCrosshair.bhdWrapped ) return;
  const original = utils.aimCrosshair;
  const wrapped = async function(args={}) {
    const run = getActiveRemoteRun();
    const token = args.token?.document ?? args.token;
    if ( !run || !token?.parent || args.centerpoint ) return original.call(this, args);
    const config = args.crosshairsConfig ?? {};
    const scene = token.parent;
    const grid = scene.grid;
    // Tamaño de la mirilla de Cauldron: `size` = distancia × ancho / 2 (en Summons#_spawn).
    const width = Math.max(1, Math.round(((Number(config.size) || (grid.distance / 2)) * 2) / grid.distance));
    const maxRange = Number(args.maxRange);
    const look = { name: config.name || run.label, src: config.icon || "icons/svg/target.svg", width, height: width };
    let finish;
    const done = new Promise(resolve => finish = resolve);
    const session = createSession({
      kind: "aim", user: run.user, actor: run.actor, token, scene, label: config.name || run.label,
      range: { max: (Number.isFinite(maxRange) && (maxRange > 0)) ? maxRange : Infinity, label: maxRange ? `${maxRange} ${grid.units}` : "" },
      looks: [look], resolve: finish
    });
    const tag = `BHD Companion | [${run.user.name}] ${run.label}`;
    console.log(`${tag} | Cauldron pide colocar "${look.name}" → al teléfono`, { maxRange, width });
    await showPreviews(session);
    const answer = await askPhone(run, "summonAim", { sessionId: session.id, title: look.name, img: look.src, state: getState(session) });
    if ( answer === RELAY_NO_ANSWER ) {
      console.warn(`${tag} | El teléfono no contestó; la mirilla de Cauldron sale aquí`);
      closeSession(session.id, null);
      return original.call(this, args);
    }
    // Si el teléfono no cerró la sesión (error), se cierra aquí.
    if ( sessions.has(session.id) ) closeSession(session.id, null);
    const placements = await done;
    if ( !placements?.length ) {
      console.log(`${tag} | Colocación cancelada en el teléfono`);
      return { x: token.x, y: token.y, direction: 0, cancelled: true, valid: false };
    }
    const p = placements[0];
    const result = { x: p.x + ((width * grid.sizeX) / 2), y: p.y + ((width * grid.sizeY) / 2),
      direction: Number(config.direction) || 0, cancelled: false, valid: true };
    console.log(`${tag} | Colocado desde el teléfono`, result);
    return result;
  };
  wrapped.bhdWrapped = true;
  utils.aimCrosshair = wrapped;
  console.log("BHD Companion | Cauldron: sus mirillas (invocar, teletransporte) se colocan desde el teléfono en los usos remotos");
}
