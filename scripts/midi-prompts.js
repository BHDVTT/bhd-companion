/**
 * Lo que Midi QOL le pide al teléfono del jugador, en la interfaz de la vista móvil.
 *
 * Midi manda estas peticiones por su canal de socketlib al dueño del personaje (el teléfono):
 * - `rollAbility` / `rollConcentration`: una salvación o prueba (hechizo del DM, concentración al recibir daño,
 *   prueba enfrentada...). En lugar de tirarla sola o abrir la ventana de dnd5e, sale el aviso grande de la
 *   vista con vibración; al tocar "Tirar" se hace la tirada de Midi sin ventana. Si Midi tiene tiempo límite
 *   para los jugadores (playerSaveTimeout) y se acaba, se tira sola, como haría Midi.
 * - `chooseReactions`: reacciones que el personaje puede usar (Shield, Hellish Rebuke...). Sale un aviso con
 *   tiempo límite (el de Midi) para usar una o pasar. La elegida la ejecuta el DM (midi-remote.js), no el teléfono.
 * Las funciones de Midi se envuelven en su propio canal (`socketlib.modules.get("midi-qol").functions`): lo que
 * se tira y lo que se devuelve es lo de Midi; solo cambia quién y cuándo pulsa el botón.
 */

import { isMidiActive } from "./constants.js";
import { requestMidiReaction } from "./midi-remote.js";
import { useError, useLog, useWarn } from "./use-log.js";

/**
 * Envuelve las peticiones de Midi al teléfono. Llamar en "ready", solo en vista móvil.
 * @param {object} app  La vista móvil (BHDMobileApp): muestra los avisos.
 */
export function registerMidiPrompts(app) {
  if ( !isMidiActive() ) return;
  const socket = globalThis.socketlib?.modules?.get("midi-qol");
  if ( !(socket?.functions instanceof Map) ) {
    useWarn("Midi QOL: no se encontró su canal de socketlib; sus salvaciones y reacciones saldrán en sus ventanas");
    return;
  }
  for ( const name of ["rollAbility", "rollAbilityV2"] ) {
    wrap(socket, name, (original, data) => onRollAbility(app, original, data));
  }
  wrap(socket, "rollConcentration", (original, data) => onRollConcentration(app, original, data));
  wrap(socket, "chooseReactions", (original, data) => onChooseReactions(app, original, data));
}

/**
 * @param {object} socket   Canal de socketlib de Midi.
 * @param {string} name     Función de Midi.
 * @param {Function} handler  Recibe la función original (ya ligada) y los datos.
 */
function wrap(socket, name, handler) {
  const original = socket.functions.get(name);
  if ( typeof original !== "function" ) {
    console.warn(`BHD Companion | Midi QOL no tiene la función ${name} en su canal`);
    return;
  }
  socket.functions.set(name, function(...args) {
    return handler(original.bind(this), ...args);
  });
}

/**
 * Actor de una petición de Midi (puede ser el de una ficha no vinculada).
 * @param {string} uuid
 * @returns {Actor|null}
 */
function getActor(uuid) {
  if ( !uuid ) return null;
  const actor = globalThis.MidiQOL?.MQfromActorUuid?.(uuid) ?? fromUuidSync(uuid);
  return (actor instanceof Actor) ? actor : (actor?.actor ?? null);
}

/**
 * Ajustes de Midi (tiempo límite de las tiradas y las reacciones).
 * @returns {object}
 */
function midiSettings() {
  try {
    return globalThis.MidiQOL?.configSettings?.() ?? {};
  } catch(err) {
    return {};
  }
}

/**
 * Texto plano de un trozo de HTML de Midi.
 * @param {string} html
 */
function textOf(html) {
  const template = document.createElement("template");
  template.innerHTML = String(html ?? "");
  return template.content.textContent.replace(/\s+/g, " ").trim();
}

/* -------------------------------------------- */

/**
 * Midi pide una salvación o prueba al personaje.
 * @param {object} app
 * @param {Function} original
 * @param {object} data  `{ saveDetails, displayOptions }` (o el formato antiguo, plano).
 */
async function onRollAbility(app, original, data) {
  const details = data?.saveDetails ?? {};
  const actor = getActor(details.actorUuid ?? data?.targetUuid);
  let type = details.rollType ?? data?.request ?? "save";
  if ( ["abil", "test"].includes(type) ) type = "check";
  if ( details.isConcentrationCheck ?? data?.isConcentrationCheck ) type = "concentration";
  const showDC = data?.displayOptions?.showTargetDC !== false;
  const sourceUuid = details.saveItemUuid ?? data?.saveItemUuid;
  const prompt = {
    id: foundry.utils.randomID(),
    messageId: null,
    midi: true,
    type,
    actor,
    ability: details.rollAbilities?.[0] ?? data?.ability ?? null,
    skill: details.rollSkills?.[0] ?? data?.skill ?? null,
    tool: details.rollTools?.[0] ?? data?.tool ?? null,
    dc: showDC ? (Number(details.rollDC ?? data?.rollDC) || null) : null,
    showDC,
    source: (sourceUuid && fromUuidSync(sourceUuid)?.name) || "",
    timeout: Number(midiSettings().playerSaveTimeout) || 0
  };
  useLog(`Midi pide una tirada (${type}) a ${actor?.name ?? "?"}`, {
    ability: prompt.ability, skill: prompt.skill, dc: prompt.dc, source: prompt.source
  });

  const tapped = await app.promptMidiRoll(prompt);
  useLog(tapped ? "Tirada de Midi: el jugador toca Tirar" : "Tirada de Midi: se acabó el tiempo, se tira sola");
  // La tirada de Midi, sin la ventana de dnd5e (el toque en el aviso ya es la confirmación).
  if ( data.saveDetails ) data.displayOptions = { ...(data.displayOptions ?? {}), fastForward: true };
  else data.options = { ...(data.options ?? {}), fastForward: true };
  try {
    const result = await original(data);
    app.onMidiRollDone(prompt, result);
    return result;
  } catch(err) {
    useError("Tirada de Midi | Error", err);
    throw err;
  }
}

/**
 * Midi pide una salvación de concentración (camino directo, sin flujo de salvación).
 * @param {object} app
 * @param {Function} original
 * @param {{actorUuid: string, target: number}} data
 */
async function onRollConcentration(app, original, data) {
  const prompt = {
    id: foundry.utils.randomID(),
    messageId: null,
    midi: true,
    type: "concentration",
    actor: getActor(data?.actorUuid),
    ability: null,
    dc: Number(data?.target) || null,
    showDC: true,
    source: "",
    timeout: Number(midiSettings().playerSaveTimeout) || 0
  };
  useLog(`Midi pide concentración a ${prompt.actor?.name ?? "?"}`, { dc: prompt.dc });
  await app.promptMidiRoll(prompt);
  try {
    const result = await original(data);
    app.onMidiRollDone(prompt, result);
    return result;
  } catch(err) {
    useError("Concentración de Midi | Error", err);
    throw err;
  }
}

/**
 * Midi ofrece reacciones al personaje.
 * @param {object} app
 * @param {Function} original
 * @param {object} data  tokenUuid, reactionActivityList, triggerTokenUuid, reactionFlavor, triggerType, options.
 */
async function onChooseReactions(app, original, data) {
  const activities = (data?.reactionActivityList ?? []).map(ref => {
    const uuid = (typeof ref === "string") ? ref : ref?.uuid;
    return uuid ? fromUuidSync(uuid) : null;
  }).filter(activity => activity?.item);
  // Sin reacciones que mostrar (p. ej. solo bonificaciones opcionales a la CA): lo hace Midi con su ventana.
  if ( !activities.length ) return original(data);

  const settings = midiSettings();
  const timeout = Number(data.options?.timeout) || Number(settings.reactionTimeout) || 30;
  const trigger = data.triggerTokenUuid ? (fromUuidSync(data.triggerTokenUuid)?.name ?? "") : "";
  useLog(`Midi ofrece reacciones (${data.triggerType})`, { activities: activities.map(a => a.item.name), trigger, timeout });

  const chosen = await app.promptReaction({ activities, flavor: textOf(data.reactionFlavor), trigger, timeout });
  if ( !chosen ) {
    useLog("Reacción: el jugador pasa (o se acabó el tiempo)");
    return { name: "None" };
  }
  useLog(`Reacción elegida: ${chosen.item.name} → la ejecuta el DM`);
  const result = await requestMidiReaction({
    activityUuid: chosen.uuid,
    tokenUuid: data.tokenUuid,
    triggerTokenUuid: data.triggerTokenUuid,
    options: data.options ?? {}
  });
  if ( (result?.ok === false) || !result?.uuid ) {
    useWarn(`Reacción ${chosen.item.name}: no se usó`, result);
    app.onReactionDone(chosen, result);
    return { name: "None" };
  }
  app.onReactionDone(chosen, result);
  return result;
}
