/**
 * BHD Companion — punto de entrada del módulo.
 */

import { MODULE_ID } from "./constants.js";
import { registerSettings } from "./settings.js";
import { canUseMobileView, shouldUseMobileView } from "./device.js";
import { enterMobileMode } from "./mobile-mode.js";
import { BHDMobileApp } from "./apps/mobile-app.js";
import { getCharacterChoices } from "./apps/character-data.js";

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

  // Varios cambios seguidos (p. ej. el GM aplica daño y un estado) producen un solo redibujado.
  const refresh = foundry.utils.debounce(() => app.render(), 50);

  /** ¿Este personaje aparece en la vista (el que se muestra o uno del selector)? */
  const isShown = actor => (actor?.type === "character")
    && ((actor === app.actor) || getCharacterChoices().includes(actor));

  Hooks.on("updateUser", (user, changes) => {
    if ( user.isSelf && ("character" in changes) ) refresh();
  });

  // Personajes: vida, características, permisos (si el GM da o quita un personaje), etc.
  Hooks.on("updateActor", (actor, changes) => {
    if ( isShown(actor) || ("ownership" in changes) ) refresh();
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
    if ( owner === app.actor ) refresh();
  };
  for ( const action of ["create", "update", "delete"] ) {
    Hooks.on(`${action}Item`, onItem);
    Hooks.on(`${action}ActiveEffect`, onEffect);
    // Panel de resultados de la pestaña Acciones (tarjeta del objeto usado y sus tiradas).
    Hooks.on(`${action}ChatMessage`, message => app.onChatMessage(message, action));
  }

  // Total de ataques y daños en el teléfono (el mensaje completo va al chat).
  Hooks.on("dnd5e.rollAttackV2", (rolls, { subject }={}) => app.onActivityRoll("attack", rolls, subject));
  Hooks.on("dnd5e.rollDamageV2", (rolls, { subject }={}) => app.onActivityRoll("damage", rolls, subject));
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
