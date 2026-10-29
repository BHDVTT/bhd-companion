/**
 * BHD Companion — punto de entrada del módulo.
 */

import { MODULE_ID } from "./constants.js";
import { registerSettings } from "./settings.js";
import { canUseMobileView, shouldUseMobileView } from "./device.js";
import { enterMobileMode } from "./mobile-mode.js";
import { BHDMobileApp } from "./apps/mobile-app.js";

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

  Hooks.on("updateUser", (user, changes) => {
    if ( user.isSelf && ("character" in changes) ) app.render();
  });
  Hooks.on("updateActor", actor => {
    if ( actor === game.user.character ) app.render({ parts: ["header"] });
  });
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
