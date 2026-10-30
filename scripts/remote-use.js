/**
 * Respaldo para aparatos lentos: el PC del DM usa el objeto (ataque, hechizo...) por el jugador.
 *
 * Midi QOL necesita las fichas del mapa. Normalmente el teléfono carga el mapa oculto, pero en
 * "Modo ligero" (o si el mapa no pudo cargarse, p. ej. sin WebGL) no hay fichas. Entonces el teléfono
 * pide por socketlib (lo instala Midi QOL) al DM activo que use la actividad, con los objetivos que
 * eligió el jugador. El DM:
 * - comprueba que ese jugador es dueño del personaje;
 * - marca esos objetivos como suyos (en la escena que ve, que debe ser la de la TV) mientras dura el uso;
 * - usa la actividad sin ventanas (Midi tira ataque y daño solos), con ventaja o desventaja si se pidió;
 * - devuelve el id de la tarjeta del chat, que el teléfono muestra en su panel.
 * Los usos se hacen de uno en uno (cola), para que los objetivos de un jugador no se mezclen con los de otro.
 */

import { MODULE_ID } from "./constants.js";
import { isMobileView } from "./mobile-mode.js";

/** Canal de socketlib del módulo (solo si socketlib está activo). */
let socket = null;

/** Usos pedidos al DM, en orden. */
let gmQueue = Promise.resolve();

/**
 * Registra la función que el DM ejecuta. Se llama al cargar el módulo (antes de "init"):
 * socketlib avisa con "socketlib.ready" durante "init".
 */
export function registerRemoteUse() {
  Hooks.once("socketlib.ready", () => {
    socket = globalThis.socketlib?.registerModule(MODULE_ID) ?? null;
    socket?.register("useActivity", gmUseActivity);
  });
}

/**
 * ¿Este uso debe hacerlo el PC del DM? Solo en vista móvil, con Midi QOL (sin Midi, dnd5e funciona sin
 * mapa) y cuando no hay mapa (modo ligero o el mapa no cargó) o muestra otra escena que la de la TV.
 * @returns {boolean}
 */
export function shouldUseRemotely() {
  if ( !isMobileView() || !game.modules.get("midi-qol")?.active ) return false;
  // Sin mapa, o el mapa muestra otra escena (las fichas de la TV no están dibujadas aquí).
  return !canvas?.ready || (canvas.scene !== game.scenes.active);
}

/**
 * Pide al DM que use una actividad.
 * @param {Activity} activity
 * @param {object} options
 * @param {string} options.mode         "normal", "advantage", "disadvantage" o "full".
 * @param {string[]} options.targetIds  Fichas objetivo (de la escena activa).
 * @param {string|null} options.sceneId Escena activa (la de la TV).
 * @returns {Promise<{ok: boolean, reason?: string, error?: string, messageId?: string|null}>}
 */
export async function requestRemoteUse(activity, { mode, targetIds, sceneId }) {
  if ( !socket ) return { ok: false, reason: "NoSocketlib" };
  if ( !game.users.activeGM ) return { ok: false, reason: "NoGM" };
  return socket.executeAsGM("useActivity", {
    actorUuid: activity.actor.uuid,
    itemId: activity.item.id,
    activityId: activity.id,
    mode, targetIds, sceneId
  });
}

/* -------------------------------------------- */
/*  Lado del DM                                 */
/* -------------------------------------------- */

/**
 * Lo ejecuta el DM (socketlib pone en `this.socketdata.userId` quién lo pidió).
 * @this {{socketdata: {userId: string}}}
 * @param {object} data
 */
function gmUseActivity(data) {
  const userId = this?.socketdata?.userId;
  const run = gmQueue.then(() => runRemoteUse(userId, data));
  gmQueue = run.catch(() => {});
  return run;
}

/**
 * @param {string} userId
 * @param {object} data
 */
async function runRemoteUse(userId, { actorUuid, itemId, activityId, mode, targetIds=[], sceneId }) {
  const user = game.users.get(userId);
  const actor = fromUuidSync(actorUuid);
  const activity = actor?.items.get(itemId)?.system.activities?.get(activityId);
  const userName = user?.name ?? userId;
  if ( !user || !actor?.testUserPermission(user, "OWNER") ) return { ok: false, reason: "NotOwner" };
  if ( !activity ) return { ok: false, reason: "NotFound" };
  console.log(`BHD Companion | [${userName}] El DM usa ${activity.item.name} (${activity.type}) por el jugador`, { mode, targetIds });

  // Los objetivos del jugador pasan a ser los del DM durante el uso (Midi y dnd5e leen game.user.targets).
  const viewing = canvas?.ready && (canvas.scene?.id === sceneId);
  if ( targetIds.length && !viewing ) return { ok: false, reason: "GMNotViewing" };
  const previous = canvas?.ready ? Array.from(game.user.targets).map(t => t.id) : [];
  if ( viewing ) canvas.tokens.setTargets(targetIds.filter(id => canvas.tokens.get(id)), { mode: "replace" });

  try {
    const workflowOptions = {
      targetConfirmation: "none",
      autoRollAttack: true,
      fastForwardAttack: true,
      autoRollDamage: "onHit",
      fastForwardDamage: true
    };
    if ( mode === "advantage" ) workflowOptions.advantage = true;
    else if ( mode === "disadvantage" ) workflowOptions.disadvantage = true;
    const results = await activity.use({ midiOptions: { workflowOptions } }, { configure: false }, {});
    const messageId = results?.message?.id ?? null;
    console.log(`BHD Companion | [${userName}] Uso de ${activity.item.name} terminado`, { messageId });
    return results ? { ok: true, messageId } : { ok: false, reason: "Cancelled" };
  } catch(err) {
    console.error(`BHD Companion | [${userName}] Error al usar ${activity.item.name} en el PC del DM`, err);
    return { ok: false, reason: "Error", error: err?.message ?? String(err) };
  } finally {
    if ( canvas?.ready ) canvas.tokens.setTargets(previous.filter(id => canvas.tokens.get(id)), { mode: "replace" });
  }
}
