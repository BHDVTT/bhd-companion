/**
 * Salvaciones que Midi QOL pide a los jugadores con "Prompt Players to Roll Saves = Chat Message".
 *
 * En ese modo Midi no manda nada al teléfono: escribe en el chat una línea de texto (sin datos ni botón) y espera
 * a que el jugador tire la salvación desde su hoja. La reconoce así (`Workflow#processSaveRoll`, Midi 13 y 14):
 * el primer mensaje de tirada de dnd5e cuyo `speaker.token` sea la ficha a la que se lo pidió
 * (`saveRequests[target.id]`). Si pasa `playerSaveTimeout`, la tira Midi.
 *
 * Por eso la petición se toma donde Midi la crea, con sus datos (no del texto del chat):
 * 1. Cliente que ejecuta el flujo de Midi (normalmente el DM): se envuelve
 *    `MidiQOL.Workflow.prototype.createPlayerChatSaveRequest` y se manda al jugador `midiSaveRequest` con la
 *    ficha, la característica, la CD (si Midi la enseña), ventaja / desventaja que calculó Midi, el hechizo y quién
 *    lo lanzó. Cuando Midi recibe la tirada (o la tira él) llega `midiSaveRolled`; con el hook
 *    `midi-qol.postCheckSaves`, `midiSaveResult` (si pasó, decidido por Midi).
 * 2. Teléfono: aviso grande con cuenta atrás. "Tirar" hace la tirada normal de dnd5e (con Midi activo en el
 *    teléfono, igual que desde la hoja) y fuerza `speaker.token` a esa ficha, para que Midi la ligue a su petición.
 * 3. Si el teléfono estuvo apagado, al volver pregunta (`midiSaveQuery`) y el DM reenvía las que siguen abiertas.
 */

import { MODULE_ID } from "./constants.js";
import { useError, useLog, useWarn } from "./use-log.js";

const SOCKET = `module.${MODULE_ID}`;

/**
 * Peticiones abiertas que mandó este cliente (el que ejecuta el flujo de Midi), por id.
 * @type {Map<string, {data: object, endsAt: number|null}>}
 */
const pending = new Map();

/**
 * Peticiones ya contestadas que esperan el resultado de Midi (pasó / falló), por id.
 * @type {Map<string, {userId: string, workflowId: string, tokenId: string}>}
 */
const awaitingResult = new Map();

/* -------------------------------------------- */
/*  Cliente del flujo de Midi (DM)              */
/* -------------------------------------------- */

/**
 * Envuelve la petición por chat de Midi y atiende las preguntas de los teléfonos. Llamar en "ready" en todos los
 * clientes con Midi (el flujo corre normalmente en el DM, pero puede correr en el PC de un jugador).
 */
export function registerMidiChatSaves() {
  const proto = globalThis.MidiQOL?.Workflow?.prototype;
  if ( typeof proto?.createPlayerChatSaveRequest !== "function" ) {
    console.warn("BHD Companion | Midi QOL: no se encontró Workflow#createPlayerChatSaveRequest; "
      + "las salvaciones por chat no llegarán al teléfono");
    return;
  }
  const original = proto.createPlayerChatSaveRequest;
  proto.createPlayerChatSaveRequest = function(target, player, saveDetails, rollType, rollAbilities, rollSkills,
    rollTools, rollDC, ...rest) {
    const result = original.call(this, target, player, saveDetails, rollType, rollAbilities, rollSkills, rollTools,
      rollDC, ...rest);
    try {
      announceRequest(this, { target, player, saveDetails, rollType, rollAbilities, rollSkills, rollTools, rollDC },
        result?.promise);
    } catch(err) {
      console.error("BHD Companion | Salvación por chat de Midi: no se pudo avisar al teléfono", err);
    }
    return result;
  };
  Hooks.on("midi-qol.postCheckSaves", announceResults);
  game.socket.on(SOCKET, data => {
    if ( data?.type === "midiSaveQuery" ) resendPending(data.userId);
  });
  console.log("BHD Companion | Midi QOL: las salvaciones por chat se mandan al teléfono del jugador");
}

/**
 * Midi acaba de pedir una salvación por chat: se manda al teléfono del jugador con los datos de Midi.
 * @param {Workflow} workflow
 * @param {object} request  Los argumentos de `createPlayerChatSaveRequest`.
 * @param {Promise} promise  Se cumple con la tirada (la del jugador o la que hace Midi al acabarse el tiempo).
 */
function announceRequest(workflow, { target, player, saveDetails, rollType, rollAbilities, rollSkills, rollTools, rollDC },
  promise) {
  const actor = target?.actor;
  if ( !player || player.isGM || !actor ) return;
  if ( (rollType === "tool") || rollTools?.length ) {
    console.log(`BHD Companion | Salvación por chat: ${actor.name} debe tirar una herramienta; se deja a Midi`);
    return;
  }
  const settings = globalThis.MidiQOL?.configSettings?.() ?? {};
  const timeout = Number(settings.playerSaveTimeout) || 0;
  // Igual que la línea del chat de Midi (`requestPCSave`): la CD se enseña si `shouldDisplaySaveDC()`.
  const showDC = globalThis.MidiQOL?.shouldDisplaySaveDC?.()
    ?? (game.settings.get("dnd5e", "challengeVisibility") !== "none");
  const concentration = !!saveDetails?.isConcentrationCheck;
  const id = `${workflow.id}.${target.id}`;
  const data = {
    type: "midiSaveRequest",
    id,
    userId: player.id,
    workflowId: workflow.id,
    sceneId: target.document?.parent?.id ?? null,
    tokenId: target.id,
    actorUuid: actor.uuid,
    rollType: concentration ? "concentration" : (rollType || "save"),
    abilities: rollAbilities ?? [],
    skills: rollSkills ?? [],
    dc: Number.isFinite(rollDC) ? rollDC : null,
    showDC: !!showDC,
    advantage: !!saveDetails?.advantage,
    disadvantage: !!saveDetails?.disadvantage,
    source: workflow.saveItem?.name ?? workflow.item?.name ?? "",
    caster: workflow.token?.name ?? workflow.actor?.name ?? "",
    timeout,
    remainingMs: timeout * 1000
  };
  pending.set(id, { data, endsAt: timeout ? Date.now() + (timeout * 1000) : null });
  console.log(`BHD Companion | Salvación por chat de Midi → teléfono de ${player.name}`, {
    actor: actor.name, tipo: data.rollType, habilidad: data.abilities[0] ?? data.skills[0], cd: data.dc,
    ventaja: data.advantage, desventaja: data.disadvantage, de: data.source, tiempo: timeout
  });
  game.socket.emit(SOCKET, data, { recipients: [player.id] });

  Promise.resolve(promise).then(result => {
    pending.delete(id);
    const roll = Array.isArray(result) ? result[0] : result;
    const total = Number.isFinite(roll?.total) ? roll.total : null;
    console.log(`BHD Companion | Salvación por chat: Midi recibió la tirada de ${actor.name} (${total ?? "?"})`);
    awaitingResult.set(id, { userId: player.id, workflowId: workflow.id, tokenId: target.id });
    game.socket.emit(SOCKET, { type: "midiSaveRolled", id, userId: player.id, total }, { recipients: [player.id] });
  }).catch(err => {
    pending.delete(id);
    console.error("BHD Companion | Salvación por chat: error en la petición de Midi", err);
    game.socket.emit(SOCKET, { type: "midiSaveRolled", id, userId: player.id, total: null }, { recipients: [player.id] });
  });
}

/**
 * Hook `midi-qol.postCheckSaves`: Midi ya decidió quién pasó (con cobertura, bonificadores, éxitos automáticos...).
 * @param {Workflow} workflow
 */
function announceResults(workflow) {
  for ( const [id, entry] of awaitingResult ) {
    if ( entry.workflowId !== workflow?.id ) continue;
    awaitingResult.delete(id);
    const success = Array.from(workflow.saves ?? []).some(t => (t?.id ?? t?.document?.id) === entry.tokenId);
    console.log(`BHD Companion | Salvación por chat: resultado de Midi (${success ? "pasó" : "falló"})`, id);
    game.socket.emit(SOCKET, { type: "midiSaveResult", id, userId: entry.userId, success }, { recipients: [entry.userId] });
  }
}

/**
 * Un teléfono volvió (pantalla encendida, reconexión): se le reenvían sus peticiones abiertas con el tiempo que queda.
 * @param {string} userId
 */
function resendPending(userId) {
  const now = Date.now();
  for ( const [id, { data, endsAt }] of pending ) {
    if ( data.userId !== userId ) continue;
    if ( endsAt && (endsAt <= now) ) continue;
    const remainingMs = endsAt ? (endsAt - now) : 0;
    console.log(`BHD Companion | Salvación por chat: reenviada al volver el teléfono (${Math.ceil(remainingMs / 1000)} s)`, id);
    game.socket.emit(SOCKET, { ...data, remainingMs }, { recipients: [userId] });
  }
}

/* -------------------------------------------- */
/*  Teléfono                                    */
/* -------------------------------------------- */

/**
 * Escucha las peticiones en el teléfono y pregunta por las que se perdieron con la pantalla apagada.
 * Llamar en "ready", solo en vista móvil.
 * @param {object} app  BHDMobileApp: `promptMidiChatSave`, `onMidiChatSaveRolled`, `onMidiChatSaveResult`.
 */
export function listenMidiChatSaves(app) {
  game.socket.on(SOCKET, data => {
    if ( data?.userId !== game.user.id ) return;
    switch ( data.type ) {
      case "midiSaveRequest": return onRequest(app, data);
      case "midiSaveRolled": return app.onMidiChatSaveRolled(data.id, data.total);
      case "midiSaveResult": return app.onMidiChatSaveResult(data.id, data.success);
    }
  });
  const query = reason => {
    useLog(`Salvación por chat: pregunto si hay alguna pendiente (${reason})`);
    game.socket.emit(SOCKET, { type: "midiSaveQuery", userId: game.user.id });
  };
  document.addEventListener("visibilitychange", () => {
    if ( !document.hidden ) query("el teléfono volvió");
  });
  game.socket.io?.on("reconnect", () => query("reconexión"));
  Hooks.on("bhd-companion.reconnected", () => query("botón Reconectar"));
  query("al abrir la vista");
}

/**
 * @param {object} app
 * @param {object} data  `midiSaveRequest`.
 */
function onRequest(app, data) {
  const actor = fromUuidSync(data.actorUuid);
  if ( !(actor instanceof Actor) ) {
    useWarn("Salvación por chat: no encuentro el personaje", data.actorUuid);
    return;
  }
  const ability = data.abilities[0] ?? null;
  const skill = data.skills[0] ?? null;
  const prompt = {
    id: data.id,
    messageId: null,
    midiChat: true,
    type: data.rollType,
    actor,
    ability,
    skill,
    dc: data.showDC ? data.dc : null,
    targetDC: data.dc,
    showDC: data.showDC,
    advantage: data.advantage,
    disadvantage: data.disadvantage,
    source: data.source,
    caster: data.caster,
    tokenId: data.tokenId,
    sceneId: data.sceneId,
    abilities: data.abilities,
    skills: data.skills,
    timeout: data.timeout,
    endsAt: data.remainingMs ? Date.now() + data.remainingMs : null
  };
  useLog(`Salvación por chat: Midi la pide a ${actor.name}`, {
    tipo: prompt.type, habilidad: ability ?? skill, cd: prompt.dc, ventaja: prompt.advantage,
    desventaja: prompt.disadvantage, de: prompt.source, lanzó: prompt.caster,
    segundos: prompt.endsAt ? Math.ceil(data.remainingMs / 1000) : "sin límite"
  });
  app.promptMidiChatSave(prompt);
}

/**
 * Tira la salvación pedida por Midi con la tirada normal de dnd5e (con Midi activo, la misma que desde la hoja).
 * Midi la reconoce por `speaker.token`, así que se fija la ficha a la que se pidió (el teléfono puede no tener
 * esa escena en su mapa).
 * @param {object} prompt
 * @param {"advantage"|"normal"|"disadvantage"|null} mode  Null: la ventaja / desventaja que calculó Midi.
 * @param {Event} [event]
 * @returns {Promise<Roll|null>}
 */
export async function rollMidiChatSave(prompt, mode, event) {
  const actor = prompt.actor;
  const advantage = mode ? (mode === "advantage") : (prompt.advantage && !prompt.disadvantage);
  const disadvantage = mode ? (mode === "disadvantage") : (prompt.disadvantage && !prompt.advantage);
  const concentration = prompt.type === "concentration";
  // advantage y disadvantage explícitos: Midi no los vuelve a calcular (ya los calculó para la petición).
  const config = {
    event,
    advantage,
    disadvantage,
    midiOptions: {
      mapKeys: false,
      fastForward: true,
      rollAbilities: prompt.abilities,
      rollSkills: prompt.skills,
      isConcentrationCheck: concentration
    }
  };
  if ( Number.isFinite(prompt.targetDC) ) config.target = prompt.targetDC;
  if ( prompt.type === "skill" ) config.skill = prompt.skill;
  else if ( prompt.ability ) config.ability = prompt.ability;

  // El mensaje de la tirada habla como la ficha a la que Midi pidió la salvación.
  const hookId = Hooks.on("preCreateChatMessage", (message, data) => {
    if ( !data.rolls?.length && !message.rolls?.length ) return;
    if ( message.speaker?.actor !== actor.id ) return;
    if ( (message.speaker.token !== prompt.tokenId) || (message.speaker.scene !== prompt.sceneId) ) {
      useLog("Salvación por chat: ajusto la ficha del mensaje para que Midi lo reconozca", {
        antes: message.speaker.token ?? null, ahora: prompt.tokenId
      });
      message.updateSource({ speaker: { ...message.speaker, token: prompt.tokenId, scene: prompt.sceneId } });
    }
    Hooks.off("preCreateChatMessage", hookId);
  });
  useLog(`Salvación por chat: ${actor.name} tira (${mode ?? "según Midi"})`, {
    tipo: prompt.type, habilidad: config.skill ?? config.ability, ventaja: advantage, desventaja: disadvantage
  });
  try {
    const dialog = { configure: false };
    let rolls;
    if ( prompt.type === "skill" ) rolls = await actor.rollSkill(config, dialog);
    else if ( prompt.type === "check" ) rolls = await actor.rollAbilityCheck(config, dialog);
    else if ( concentration && !config.ability ) rolls = await actor.rollConcentration(config, dialog);
    else rolls = await actor.rollSavingThrow(config, dialog);
    const roll = Array.isArray(rolls) ? rolls[0] : rolls;
    useLog(`Salvación por chat: tirada hecha (${roll?.total ?? "sin tirada"}); Midi la recibe en el DM`);
    return roll ?? null;
  } catch(err) {
    useError("Salvación por chat | Error al tirar", err?.message ?? String(err));
    throw err;
  } finally {
    Hooks.off("preCreateChatMessage", hookId);
  }
}
