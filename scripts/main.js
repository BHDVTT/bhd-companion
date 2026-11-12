/**
 * BHD Companion — punto de entrada del módulo.
 */

import { isMidiActive, MODULE_ID } from "./constants.js";
import { registerSettings } from "./settings.js";
import { canUseMobileView, reloadWithoutUrlMode, shouldUseMobileView } from "./device.js";
import { enterMobileMode } from "./mobile-mode.js";
import { closeStrayWindows } from "./mobile-windows.js";
import { BHDMobileApp } from "./apps/mobile-app.js";
import { getCharacterChoices } from "./apps/character-data.js";
import { getActiveCombat } from "./apps/combat-data.js";
import { watchConnection } from "./connection.js";
import { updateWakeLock } from "./wake-lock.js";
import { registerMovementSocket } from "./movement.js";
import { broadcastTargets, pruneTargets } from "./targets.js";
import { registerUseLogSocket, useLog } from "./use-log.js";
import { enableGmRemoteHelpers, registerMidiRemote } from "./midi-remote.js";
import { registerDialogRelay } from "./dialog-relay.js";
import { registerCprDialogSocket, registerCprDialogsGM, registerCprDialogsPhone } from "./cpr-dialogs.js";
import { registerTransformSocket } from "./transform.js";
import { registerMidiPrompts } from "./midi-prompts.js";
import { listenMidiChatSaves, registerMidiChatSaves } from "./midi-chat-saves.js";
import { registerTemplatePlacement } from "./template-placement.js";
import { registerGmInspiration } from "./gm-inspiration.js";
import { recordEffect, recordHitPoints, recordMessage } from "./diary.js";

/** ¿Este cliente está en vista móvil? Se decide una sola vez al cargar. */
let mobileView = false;

// Con Midi QOL los teléfonos piden al DM que use sus objetos (socketlib avisa durante "init").
registerMidiRemote();
registerDialogRelay();
registerCprDialogSocket();
registerTransformSocket();
registerTemplatePlacement();

Hooks.once("init", () => {
  console.log(`BHD Companion ${game.modules.get(MODULE_ID)?.version ?? ""} cargado`);
  registerSettings();
});

// "setup" ocurre antes de que Foundry dibuje el mapa y la interfaz: es el momento de decidir.
Hooks.once("setup", () => {
  mobileView = shouldUseMobileView();
  if ( mobileView ) enterMobileMode();
  // El DM ejecuta lo que piden los teléfonos: sus áreas e invocaciones se colocan solas.
  if ( game.user.isGM && isMidiActive() ) enableGmRemoteHelpers();
});

Hooks.once("ready", () => {
  // Pestaña Mover: el DM mueve las fichas que piden los teléfonos y la TV las sigue.
  registerMovementSocket();
  // Registro de los ataques del teléfono: el DM lo ve en su consola (F12).
  registerUseLogSocket();
  // Midi QOL con salvaciones por chat: la petición va al teléfono del jugador (en el cliente que corre el flujo).
  if ( isMidiActive() ) registerMidiChatSaves();
  // DM: estrella junto a cada jugador para dar Inspiración (al teléfono le llega un aviso).
  if ( game.user.isGM ) registerGmInspiration();
  // Cauldron of Plentiful Resources: durante un uso del teléfono, sus preguntas van a ese teléfono.
  if ( game.user.isGM ) registerCprDialogsGM();
  if ( mobileView ) openMobileView();
  else if ( canUseMobileView() ) addReturnToMobileButton();
});

/* -------------------------------------------- */

/**
 * Abre la vista móvil y la mantiene al día con el personaje del jugador.
 */
function openMobileView() {
  closeStrayWindows();
  const app = new BHDMobileApp();
  app.render({ force: true });
  game.modules.get(MODULE_ID).api = { app };
  watchConnection();
  updateWakeLock();
  // Con Midi QOL: sus salvaciones y reacciones salen en los avisos de la vista.
  registerMidiPrompts(app);
  // Cauldron of Plentiful Resources: sus preguntas salen en el aviso grande de la vista.
  registerCprDialogsPhone();
  if ( isMidiActive() ) listenMidiChatSaves(app);

  // Varios cambios seguidos (p. ej. el GM aplica daño y un estado) producen un solo redibujado.
  // Con la pantalla apagada o en otra app no se dibuja nada (ahorra batería): se hace una vez al volver.
  // Un dibujo que falla (p. ej. un dato raro de un objeto) se apunta en la consola y no tumba los siguientes.
  let pendingRender = false;
  const draw = () => Promise.resolve(app.render()).catch(err => console.error("BHD Companion | Error al dibujar la vista", err));
  const refresh = foundry.utils.debounce(() => {
    if ( document.hidden ) pendingRender = true;
    else draw();
  }, 50);
  document.addEventListener("visibilitychange", () => {
    if ( document.hidden || !pendingRender ) return;
    pendingRender = false;
    draw();
  });

  /** ¿Este actor aparece en la vista (el que se muestra, uno del selector de personajes o un compañero)? */
  const isShown = actor => !!actor && ((actor === app.actor) || app.myActors.includes(actor)
    || ((actor.type === "character") && getCharacterChoices().includes(actor)));

  /** ¿Este actor está en el combate activo? (su vida aproximada se ve en la pestaña Combate) */
  const inCombat = actor => !!actor && !!getActiveCombat()?.combatants.some(c => c.actor === actor);

  Hooks.on("updateUser", (user, changes) => {
    if ( !user.isSelf || !("character" in changes) ) return;
    refresh();
    app.onCombatUpdate();
  });

  // Personajes: vida, características, permisos (si el GM da o quita un personaje), etc.
  Hooks.on("updateActor", (actor, changes, options, userId) => {
    // Al guardar las notas mientras se escribe, no hace falta redibujar (el texto ya está en pantalla).
    if ( (userId === game.user.id) && isOnlyModuleFlags(changes) ) return;
    if ( isShown(actor) || inCombat(actor) || ("ownership" in changes) ) refresh();
    // El DM (u otro jugador) le dio Inspiración: aviso con vibración.
    const inspiration = foundry.utils.getProperty(changes, "system.attributes.inspiration");
    if ( (inspiration === true) && (userId !== game.user.id) && app.myActors.includes(actor) ) app.onInspirationGranted(actor);
  });
  Hooks.on("createActor", actor => {
    if ( actor.type === "character" ) refresh();
  });
  Hooks.on("deleteActor", actor => {
    if ( actor.type === "character" ) refresh();
  });

  // Objetos (clases, armaduras...) y efectos (condiciones, bonificadores) del personaje.
  const onItem = item => {
    if ( item.parent === app.actor ) refresh();
  };
  const onEffect = effect => {
    const owner = (effect.parent instanceof Actor) ? effect.parent : effect.parent?.parent;
    if ( (owner === app.actor) || inCombat(owner) ) refresh();
  };
  // Combate: inicio y fin, ronda y turno, iniciativas, combatientes que entran, salen o caen.
  const onCombat = () => {
    refresh();
    app.onCombatUpdate();
  };
  for ( const action of ["create", "update", "delete"] ) {
    Hooks.on(`${action}Item`, onItem);
    Hooks.on(`${action}ActiveEffect`, onEffect);
    Hooks.on(`${action}Combat`, onCombat);
    Hooks.on(`${action}Combatant`, onCombat);
    // Panel de resultados de la pestaña Acciones (tarjeta del objeto usado y sus tiradas).
    Hooks.on(`${action}ChatMessage`, message => app.onChatMessage(message, action));
  }

  // Diario de la sesión: tiradas y usos del chat, daño y curación (hooks de dnd5e), condiciones y efectos.
  // Efectos con duración: aviso cuando terminan.
  Hooks.on("createChatMessage", message => {
    if ( recordMessage(message, app.myActors) ) app.onDiaryChanged();
  });
  for ( const hook of ["dnd5e.damageActor", "dnd5e.healActor"] ) {
    Hooks.on(hook, (actor, changes) => {
      if ( app.myActors.includes(actor) && recordHitPoints(actor, changes) ) app.onDiaryChanged();
    });
  }
  Hooks.on("createActiveEffect", effect => {
    if ( app.myActors.includes(effect.parent) && recordEffect(effect, true) ) app.onDiaryChanged();
  });
  Hooks.on("deleteActiveEffect", effect => {
    app.onEffectDeleted(effect);
    if ( app.myActors.includes(effect.parent) && recordEffect(effect, false) ) app.onDiaryChanged();
  });

  // Pestañas Mover y Combate (bloque Movimiento): fichas del jugador en la escena de la TV
  // (posición, pies recorridos), cambio de escena activa y pausa. Solo si la pestaña está abierta.
  const onMoveChange = () => {
    if ( ["move", "combat"].includes(app.activeTab) ) refresh();
  };
  const onToken = token => {
    if ( (token.parent === game.scenes.active) && token.isOwner ) onMoveChange();
  };
  for ( const action of ["create", "update", "delete"] ) Hooks.on(`${action}Token`, onToken);
  // Compañeros e invocaciones: aparecen y desaparecen del selector de la cabecera con su ficha.
  // Los cambios de un compañero de ficha no vinculada (vida, estados) llegan como cambios de la ficha.
  const onCompanionToken = (token, action) => {
    if ( (token.parent !== game.scenes.active) || !token.isOwner || (token.actor?.type === "character") ) return;
    if ( action !== "update" ) {
      useLog(`Compañero: ${token.name} ${action === "create" ? "aparece en" : "sale de"} la escena`);
      app.checkCompanion();
      refresh();
    }
    else if ( token.actor === app.actor ) refresh();
  };
  for ( const action of ["create", "update", "delete"] ) Hooks.on(`${action}Token`, token => onCompanionToken(token, action));
  // Transformación (Wild Shape, Polymorph): dnd5e cambia el actor de la ficha; la vista pasa a la forma o vuelve.
  Hooks.on("updateToken", (token, changes) => {
    if ( (token.parent !== game.scenes.active) || !token.isOwner ) return;
    const transformed = ("actorId" in changes) || ("delta" in changes)
      || foundry.utils.hasProperty(changes, "flags.dnd5e.isPolymorphed");
    if ( !transformed ) return;
    useLog(`Ficha ${token.name}: cambió de actor (¿transformación?) → redibujar`);
    refresh();
  });
  // Objetivos: si su ficha desaparece o el DM cambia de escena, dejan de ser objetivos.
  Hooks.on("deleteToken", () => pruneTargets());
  Hooks.on("updateScene", (scene, changes) => {
    if ( "active" in changes ) pruneTargets();
    if ( ("active" in changes) || ("grid" in changes) ) onMoveChange();
  });
  Hooks.on("pauseGame", onMoveChange);

  // HUD de combate: objetivos marcados (retratos con mirilla, barra de objetivos).
  Hooks.on("targetToken", user => {
    if ( user.isSelf && (app.activeTab === "combat") ) refresh();
  });
  // Si se cortó la conexión, la TV olvidó los objetivos de este jugador: se le vuelven a mandar.
  const resendTargets = () => {
    if ( game.user.targets.size ) broadcastTargets();
  };
  game.socket.io?.on("reconnect", resendTargets);
  Hooks.on("bhd-companion.reconnected", resendTargets);

  // HUD de combate: marcar como usada la acción, adicional o reacción de lo que se use fuera de los
  // botones de la vista. (Es un Hooks.call de dnd5e: devolver false cortaría el uso.)
  Hooks.on("dnd5e.postUseActivity", activity => {
    app.onPostUseActivity(activity);
  });

  // Ataques y daños de este personaje sin ventana de dnd5e (también los botones de las tarjetas).
  Hooks.on("dnd5e.preRollAttackV2", (config, dialog) => app.onPreRoll("attack", config, dialog));
  Hooks.on("dnd5e.preRollDamageV2", (config, dialog) => app.onPreRoll("damage", config, dialog));

  // Total de ataques y daños en el teléfono (el mensaje completo va al chat); crítico para el botón Daño.
  Hooks.on("dnd5e.rollAttackV2", (rolls, { subject }={}) => app.onActivityRoll("attack", rolls, subject));
  Hooks.on("dnd5e.rollDamageV2", (rolls, { subject }={}) => app.onActivityRoll("damage", rolls, subject));
}

/**
 * ¿Este cambio de actor solo toca datos del módulo (p. ej. las notas personales)?
 * @param {object} changes
 * @returns {boolean}
 */
function isOnlyModuleFlags(changes) {
  const keys = Object.keys(foundry.utils.flattenObject(changes))
    .filter(key => (key !== "_id") && !key.startsWith("_stats."));
  return !!keys.length && keys.every(key => key.startsWith(`flags.${MODULE_ID}.`));
}

/**
 * En un dispositivo que podría usar la vista móvil pero eligió la interfaz normal,
 * muestra un botón pequeño para volver a la vista móvil.
 */
function addReturnToMobileButton() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "bhd-return-mobile";
  button.innerHTML = `<i class="fa-solid fa-mobile-screen" aria-hidden="true"></i> ${game.i18n.localize("BHD.ReturnMobile")}`;
  button.addEventListener("click", async () => {
    await game.settings.set(MODULE_ID, "preferNormal", false);
    reloadWithoutUrlMode();
  });
  document.body.append(button);
}
