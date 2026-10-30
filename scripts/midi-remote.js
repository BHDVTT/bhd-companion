/**
 * Con Midi QOL activo, todo se ejecuta en el cliente del DM.
 *
 * Midi necesita las fichas del mapa (objetivos, alcance, áreas, animaciones) y en el teléfono no hay mapa.
 * Por eso el teléfono no usa nada: manda la petición por socketlib al DM (actor, objeto, actividad,
 * objetivos que eligió el jugador, nivel del espacio y ventaja / normal / desventaja) y el DM la ejecuta
 * con `MidiQOL.completeActivityUse`, sin ventanas ni confirmaciones:
 * - ataque y daño se tiran solos (el daño solo si impacta), con los objetivos del jugador;
 * - la tarjeta del chat habla como el personaje y Automated Animations dibuja los efectos en la TV;
 * - lo que Midi o Chris's Premades pregunten durante el uso va al teléfono del jugador (dialog-relay.js);
 * - las áreas y las invocaciones se colocan solas junto a la ficha del personaje (mobile-templates.js).
 * Al terminar, el DM devuelve el resultado (impacta o falla, crítico, daño por objetivo) para el teléfono.
 *
 * Las reacciones que Midi ofrece al jugador (midi-prompts.js) también se ejecutan aquí, sin esperar a la cola.
 */

import { MODULE_ID } from "./constants.js";
import { getSocket, registerSocketHandler } from "./remote-socket.js";
import { endRemoteRun, isRemoteRun, startRemoteRun } from "./dialog-relay.js";
import { needsUsageDialog } from "./quick-actions.js";
import { patchGmTemplatePlacement, patchTokenPlacement } from "./mobile-templates.js";

/** Cuánto espera el teléfono al DM (ms). Midi da 90 s a un uso; con preguntas al jugador puede tardar más. */
const REQUEST_TIMEOUT_MS = 150 * 1000;

/** Usos pedidos al DM, en orden (los objetivos y las ventanas de un jugador no se mezclan con los de otro). */
let gmQueue = Promise.resolve();

/**
 * Registra las funciones que ejecuta el DM. Llamar al cargar el módulo (antes de "init").
 */
export function registerMidiRemote() {
  registerSocketHandler("midiUse", gmMidiUse);
  registerSocketHandler("midiReaction", gmMidiReaction);
}

/**
 * En el cliente del DM con Midi: las áreas y las invocaciones de los usos pedidos desde un teléfono se
 * colocan solas junto a la ficha del personaje (el DM no tiene que hacer clic en el mapa). Las suyas, igual
 * que siempre. Llamar en "setup".
 */
export function enableGmRemoteHelpers() {
  patchGmTemplatePlacement(activity => isRemoteRun(activity?.actor));
  patchTokenPlacement(() => isRemoteRun());
  console.log("BHD Companion | Midi QOL activo: este cliente del DM ejecuta los usos de los teléfonos");
}

/* -------------------------------------------- */
/*  Lado del teléfono                           */
/* -------------------------------------------- */

/**
 * ¿Se puede pedir algo al DM ahora? Si no, el motivo (clave de BHD.Midi.Reason.*).
 * @returns {string|null}
 */
export function getRemoteBlock() {
  if ( !getSocket() ) return "NoSocketlib";
  if ( !game.users.activeGM ) return "NoGM";
  return null;
}

/**
 * Pide al DM que use una actividad con Midi QOL.
 * @param {Activity} activity
 * @param {object} options
 * @param {string[]} options.targetIds  Fichas objetivo de la escena activa (la de la TV).
 * @param {string|null} options.slot    Espacio de conjuro ("spell2", "pact"...).
 * @param {string} options.mode         "normal", "advantage" o "disadvantage".
 * @returns {Promise<object>}  `{ ok: true, ...resultado }` o `{ ok: false, reason, error? }`.
 */
export async function requestMidiUse(activity, { targetIds=[], slot=null, mode="normal" }={}) {
  const block = getRemoteBlock();
  if ( block ) return { ok: false, reason: block };
  return askGM("midiUse", {
    actorUuid: activity.actor.uuid,
    itemId: activity.item.id,
    activityId: activity.id,
    targetIds,
    slot,
    mode,
    sceneId: game.scenes.active?.id ?? null
  });
}

/**
 * Pide al DM que use la reacción que eligió el jugador (la que Midi le ofreció).
 * @param {object} data  activityUuid, tokenUuid, triggerTokenUuid y las opciones que mandó Midi.
 * @returns {Promise<object>}  Lo que Midi espera de su ventana de reacciones (`{ name, uuid... }`).
 */
export async function requestMidiReaction(data) {
  const block = getRemoteBlock();
  if ( block ) return { ok: false, reason: block };
  return askGM("midiReaction", data);
}

/**
 * Llama a una función del DM con tiempo límite.
 * @param {string} name
 * @param {object} data
 */
async function askGM(name, data) {
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve({ ok: false, reason: "Timeout" }), REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([getSocket().executeAsGM(name, data), timeout]);
  } catch(err) {
    // El DM tiene una versión vieja del módulo (no conoce la función): que recargue.
    const unregistered = err instanceof (globalThis.socketlib?.errors?.SocketlibUnregisteredHandlerError ?? class {});
    return { ok: false, reason: unregistered ? "GMOutdated" : "Error", error: err?.message ?? String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------- */
/*  Lado del DM                                 */
/* -------------------------------------------- */

/**
 * Uso pedido por un teléfono. Se hacen de uno en uno.
 * @this {{socketdata: {userId: string}}}
 * @param {object} data
 */
function gmMidiUse(data) {
  const userId = this?.socketdata?.userId;
  const run = gmQueue.then(() => runMidiUse(userId, data));
  gmQueue = run.catch(() => {});
  return run;
}

/**
 * @param {string} userId
 * @param {object} data
 */
async function runMidiUse(userId, { actorUuid, itemId, activityId, targetIds=[], slot=null, mode="normal", sceneId }) {
  const user = game.users.get(userId);
  const actor = fromUuidSync(actorUuid);
  const item = actor?.items?.get(itemId);
  const activity = item?.system.activities?.get(activityId);
  const tag = `BHD Companion | [${user?.name ?? userId}] ${item?.name ?? itemId}`;
  console.log(`${tag} | 1. Petición del teléfono`, { activity: activity?.name, type: activity?.type, targetIds, slot, mode });

  if ( !user || !actor?.testUserPermission(user, "OWNER") ) {
    console.warn(`${tag} | El jugador no es dueño del personaje`);
    return { ok: false, reason: "NotOwner" };
  }
  if ( !activity ) {
    console.warn(`${tag} | No se encontró la actividad ${activityId}`);
    return { ok: false, reason: "NotFound" };
  }
  if ( typeof globalThis.MidiQOL?.completeActivityUse !== "function" ) {
    console.warn(`${tag} | Midi QOL no está listo en el cliente del DM`);
    return { ok: false, reason: "NoMidi" };
  }

  // Objetivos: fichas de la escena de la TV. Midi las busca en el mapa del DM, que debe mostrar esa escena.
  const scene = game.scenes.get(sceneId) ?? game.scenes.active;
  const targetUuids = targetIds.map(id => scene?.tokens.get(id)?.uuid).filter(uuid => uuid);
  if ( targetUuids.length && (canvas?.scene !== scene) ) {
    console.warn(`${tag} | El DM no está viendo la escena de los objetivos (${scene?.name})`);
    return { ok: false, reason: "GMNotViewing" };
  }

  // Todo automático: sin confirmar objetivos, ataque sin ventana y daño solo si impacta.
  const workflowOptions = {
    targetConfirmation: "none",
    autoRollAttack: true,
    autoFastAttack: true,
    fastForwardAttack: true,
    autoRollDamage: "onHit",
    fastForwardDamage: true
  };
  const midiOptions = {
    targetUuids,
    ignoreUserTargets: true,
    fastForward: true,
    fastForwardAttack: true,
    fastForwardDamage: true,
    workflowOptions
  };
  if ( mode === "advantage" ) midiOptions.advantage = workflowOptions.advantage = true;
  else if ( mode === "disadvantage" ) midiOptions.disadvantage = workflowOptions.disadvantage = true;
  const usage = { midiOptions };
  if ( slot ) usage.spell = { slot };
  // La ventana de dnd5e solo si el sistema la pide (invocar con elección, encantamientos...): va al teléfono.
  const dialog = { configure: needsUsageDialog(activity) };

  const remote = startRemoteRun(user, actor, item.name);
  try {
    console.log(`${tag} | 2. Midi QOL empieza (objetivos: ${targetUuids.length}, ventana de dnd5e: ${dialog.configure})`);
    const workflow = await globalThis.MidiQOL.completeActivityUse(activity, usage, dialog, {});
    if ( !workflow || workflow.aborted ) {
      console.warn(`${tag} | 3. Midi QOL no completó el uso (sin espacios o usos, cancelado o tardó demasiado)`);
      return { ok: false, reason: "Cancelled" };
    }
    const result = summarizeWorkflow(workflow);
    console.log(`${tag} | 3. Terminado`, result);
    return { ok: true, ...result };
  } catch(err) {
    console.error(`${tag} | Error en Midi QOL`, err);
    return { ok: false, reason: "Error", error: err?.message ?? String(err) };
  } finally {
    endRemoteRun(remote);
  }
}

/**
 * Resultado de un uso para el teléfono, leído del flujo de Midi.
 * @param {object} workflow  Workflow de Midi QOL.
 * @returns {object}
 */
function summarizeWorkflow(workflow) {
  const hasAttack = !!workflow.attackRoll;
  const saves = workflow.saves ?? new Set();
  const failed = workflow.failedSaves ?? new Set();
  const hasSave = (saves.size + failed.size) > 0;
  const damage = new Map((workflow.damageList ?? []).map(entry => [entry.targetUuid, entry]));
  const card = workflow.itemCardUuid ? fromUuidSync(workflow.itemCardUuid) : null;
  return {
    messageId: card?.id ?? workflow.itemCardId ?? null,
    showHits: game.settings.get(MODULE_ID, "showAttackResult"),
    attack: hasAttack ? {
      total: workflow.attackTotal ?? workflow.attackRoll.total,
      critical: !!workflow.isCritical,
      fumble: !!workflow.isFumble
    } : null,
    damageTotal: Number.isFinite(workflow.damageTotal) ? workflow.damageTotal : null,
    targets: Array.from(workflow.targets ?? []).map(token => {
      const document = token.document ?? token;
      const entry = damage.get(document.uuid);
      return {
        id: document.id,
        name: document.name,
        hit: hasAttack ? !!workflow.hitTargets?.has(token) : null,
        saved: hasSave ? saves.has(token) : null,
        damage: Number.isFinite(entry?.totalDamage) ? entry.totalDamage : null
      };
    })
  };
}

/**
 * Reacción elegida en un teléfono (Shield, Hellish Rebuke...). Sin cola: suele llegar en medio de otro uso
 * (el ataque que la provoca), que se quedaría esperando a la reacción.
 * @this {{socketdata: {userId: string}}}
 * @param {object} data
 */
function gmMidiReaction(data) {
  return runMidiReaction(this?.socketdata?.userId, data);
}

/**
 * Lo mismo que hace la ventana de reacciones de Midi al elegir una (`reactionDialog`), en el DM y sin ventana.
 * @param {string} userId
 * @param {object} data
 * @returns {Promise<object>}  `{ name, uuid, itemName, itemUuid }` si se usó; `{ name: "None" }` si no.
 */
async function runMidiReaction(userId, { activityUuid, tokenUuid, triggerTokenUuid, options={} }) {
  const none = { name: "None" };
  const user = game.users.get(userId);
  const activity = await fromUuid(activityUuid);
  const actor = activity?.actor;
  const tag = `BHD Companion | [${user?.name ?? userId}] Reacción ${activity?.item?.name ?? activityUuid}`;
  console.log(`${tag} | 1. Petición del teléfono`, { triggerTokenUuid });
  if ( !user || !actor?.testUserPermission(user, "OWNER") ) {
    console.warn(`${tag} | El jugador no es dueño del personaje`);
    return none;
  }

  // Las opciones de Midi llegan como datos: el objeto y la actividad que provocaron la reacción se recuperan.
  const { item: _item, activity: triggerActivity, ...plain } = options;
  const triggerItem = plain.itemUuid ? await fromUuid(plain.itemUuid) : null;

  // Hechizo lanzado desde otro objeto (actividad "Lanzar"): el objetivo es el del hechizo.
  let targetType = activity.target?.affects?.type;
  if ( (activity.type === "cast") && !activity._source?.target?.override ) {
    const spell = activity.cachedSpell ?? fromUuidSync(activity.spell?.uuid);
    const spellActivity = spell?.system.activities?.find(a => a.canUse) ?? spell?.system.activities?.contents?.[0];
    if ( spellActivity?.target?.affects?.type ) targetType = spellActivity.target.affects.type;
  }
  const midiOptions = foundry.utils.mergeObject({
    createWorkflow: true,
    configureDialog: false,
    checkGMStatus: false,
    targetUuids: (targetType !== "self") ? [triggerTokenUuid] : [tokenUuid],
    isReaction: true,
    workflowOptions: { targetConfirmation: "none" },
    ignoreUserTargets: true
  }, plain, { inplace: false });
  if ( triggerItem ) {
    midiOptions.item = triggerItem;
    if ( triggerActivity?._id ) midiOptions.activity = triggerItem.system.activities?.get(triggerActivity._id);
  }

  const remote = startRemoteRun(user, actor, `${activity.item.name} (reacción)`);
  try {
    console.log(`${tag} | 2. Midi QOL empieza`);
    const workflow = await globalThis.MidiQOL.completeActivityUse(activity, { midiOptions },
      { configure: needsUsageDialog(activity) }, { systemCard: false });
    if ( !workflow || (workflow.currentAction !== workflow.WorkflowState_Cleanup) ) {
      console.warn(`${tag} | 3. Midi QOL no completó la reacción`);
      return none;
    }
    console.log(`${tag} | 3. Reacción usada`);
    return {
      name: workflow.activity.name,
      uuid: workflow.activity.uuid,
      itemName: workflow.activity.item.name,
      itemUuid: activity.item.uuid
    };
  } catch(err) {
    console.error(`${tag} | Error en Midi QOL`, err);
    return none;
  } finally {
    endRemoteRun(remote);
  }
}
