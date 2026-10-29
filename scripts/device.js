import { MODULE_ID } from "./constants.js";

/** Por debajo de este ancho (en píxeles CSS) consideramos que es un teléfono o pantalla pequeña. */
const SMALL_SCREEN_WIDTH = 768;

/**
 * ¿El dispositivo es un teléfono o una pantalla pequeña?
 * Se mira el lado corto de la pantalla (para que el teléfono en horizontal también cuente)
 * y el ancho de la ventana del navegador.
 * @returns {boolean}
 */
export function isSmallScreen() {
  const shortSide = Math.min(window.screen.width, window.screen.height);
  return (shortSide < SMALL_SCREEN_WIDTH) || (window.innerWidth < SMALL_SCREEN_WIDTH);
}

/**
 * ¿Este usuario en este dispositivo tiene derecho a la vista móvil?
 * No tiene en cuenta si eligió volver a la interfaz normal.
 * Requiere que los documentos estén listos (hook "setup" o posterior).
 * @returns {boolean}
 */
export function canUseMobileView() {
  if ( !game.settings.get(MODULE_ID, "enabled") ) return false;
  if ( game.user.isGM ) return false;
  return game.settings.get(MODULE_ID, "forceAll") || isSmallScreen();
}

/**
 * ¿Debemos mostrar la vista móvil ahora mismo?
 * @returns {boolean}
 */
export function shouldUseMobileView() {
  return canUseMobileView() && !game.settings.get(MODULE_ID, "preferNormal");
}
