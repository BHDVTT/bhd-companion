/**
 * BHD Companion — punto de entrada del módulo.
 */

import { MODULE_ID } from "./constants.js";
import { registerSettings } from "./settings.js";
import { canUseMobileView, shouldUseMobileView } from "./device.js";
import { enterMobileMode } from "./mobile-mode.js";
import { BHDMobileApp } from "./apps/mobile-app.js";
import { getCharacterChoices } from "./apps/character-data.js";
import { getActiveCombat } from "./apps/combat-data.js";
import { watchConnection } from "./connection.js";
import { updateWakeLock } from "./wake-lock.js";
import { registerMovementSocket } from "./movement.js";
import { broadcastTargets, pruneTargets } from "./targets.js";

/** ¿Este cliente está en vista móvil? Se decide una sola vez al cargar. */
let mobileView = false;

Hooks.once("init", () => {
  console.log("BHD Companion cargado");
  registerSettings();
});

// "setup" ocurre antes de que Foundry dibuje el mapa y la interfaz: es el momento de decidir.
Hooks.once("setup", () => {
  mobileView = shouldUseMobileView();
  if ( mobileView ) enterMobileMode();
});

Hooks.once("ready", () => {
  // Pestaña Mover: el DM mueve las fichas que piden los teléfonos y la TV las sigue.
  registerMovementSocket();
  if ( mobileView ) openMobileView();
  else if ( canUseMobileView() ) addReturnToMobileButton();
});

/* -------------------------------------------- */

/**
 * Abre la vista móvil y la mantiene al día con el personaje del jugador.
 */
function openMobileView() {
  const app = new BHDMobileApp();
  app.render({ force: true });
  game.modules.get(MODULE_ID).api = { app };
  watchConnection();
  updateWakeLock();

  // Varios cambios seguidos (p. ej. el GM aplica daño y un estado) producen un solo redibujado.
  // Con la pantalla apagada o en otra app no se dibuja nada (ahorra batería): se hace una vez al volver.
  let pendingRender = false;
  const refresh = foundry.utils.debounce(() => {
    if ( document.hidden ) pendingRender = true;
    else app.render();
  }, 50);
  document.addEventListener("visibilitychange", () => {
    if ( document.hidden || !pendingRender ) return;
    pendingRender = false;
    app.render();
  });

  /** ¿Este personaje aparece en la vista (el que se muestra o uno del selector)? */
  const isShown = actor => (actor?.type === "character")
    && ((actor === app.actor) || getCharacterChoices().includes(actor));

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

  // Pestañas Mover y Combate (bloque Movimiento): fichas del jugador en la escena de la TV
  // (posición, pies recorridos), cambio de escena activa y pausa. Solo si la pestaña está abierta.
  const onMoveChange = () => {
    if ( ["move", "combat"].includes(app.activeTab) ) refresh();
  };
  const onToken = token => {
    if ( (token.parent === game.scenes.active) && token.isOwner ) onMoveChange();
  };
  for ( const action of ["create", "update", "delete"] ) Hooks.on(`${action}Token`, onToken);
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
  game.socket.io?.on("reconnect", () => {
    if ( game.user.targets.size ) broadcastTargets();
  });

  // HUD de combate: marcar como usada la acción, adicional o reacción de lo que se use.
  // (Es un Hooks.call de dnd5e: devolver false cortaría el uso, así que no se devuelve nada.)
  Hooks.on("dnd5e.postUseActivity", activity => {
    app.onPostUseActivity(activity);
  });

  // Toque rápido: usar y tirar sin ventanas; toque largo: ventaja / desventaja.
  Hooks.on("dnd5e.preUseActivity", (activity, usage, dialog) => app.onPreUseActivity(activity, usage, dialog));
  Hooks.on("dnd5e.preRollAttackV2", (config, dialog) => app.onPreRoll("attack", config, dialog));
  Hooks.on("dnd5e.preRollDamageV2", (config, dialog) => app.onPreRoll("damage", config, dialog));

  // Total de ataques y daños en el teléfono (el mensaje completo va al chat).
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
    window.location.reload();
  });
  document.body.append(button);
}
