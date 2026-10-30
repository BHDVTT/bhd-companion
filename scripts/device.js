import { MODULE_ID } from "./constants.js";

/** Por debajo de este ancho (en píxeles CSS) consideramos que es un teléfono o pantalla pequeña. */
const SMALL_SCREEN_WIDTH = 768;

/** Lado corto máximo (px CSS) de una tableta: los iPad más grandes miden 1024 px de lado corto. */
const TABLET_SHORT_SIDE = 1100;

/** Navegadores de televisores y aparatos de TV (Android TV, Fire TV, Chromecast, Samsung, LG...). */
const TV_USER_AGENT = /\b(?:smart-?tv|googletv|android ?tv|aft\w*|crkey|bravia|tizen|web0s|webos|netcast|hbbtv|roku|appletv|playstation|xbox)\b/i;

/** Navegadores de teléfonos y tabletas que se identifican como tales. */
const MOBILE_USER_AGENT = /\b(?:iphone|ipad|ipod|android|mobile)\b/i;

/** Clave de sessionStorage donde se recuerda el `?bhd=` del enlace (sobrevive a las recargas de la pestaña). */
const URL_MODE_KEY = `${MODULE_ID}.urlViewMode`;

/** Valores del ajuste "viewMode" y del parámetro `?bhd=`. */
export const VIEW_MODES = ["auto", "mobile", "normal"];

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
 * Lo que se sabe del dispositivo, para decidir y para el registro de la consola.
 * @returns {object}
 */
export function describeDevice() {
  const ua = navigator.userAgent ?? "";
  const touchPoints = navigator.maxTouchPoints ?? 0;
  const media = query => window.matchMedia?.(query).matches ?? false;
  return {
    userAgent: ua,
    touchPoints,
    // Safari en iPad (iPadOS 13+) dice ser un Mac de escritorio; un Mac de verdad no tiene pantalla táctil.
    iPadAsMac: /macintosh/i.test(ua) && (touchPoints > 1),
    mobileUA: MOBILE_USER_AGENT.test(ua),
    tv: TV_USER_AGENT.test(ua),
    // Puntero principal: el dedo (sin ratón que pase por encima).
    touchPrimary: media("(pointer: coarse)") && media("(hover: none)"),
    // Hay algún ratón o trackpad (un PC, aunque tenga pantalla táctil).
    finePointer: media("(any-pointer: fine)"),
    shortSide: Math.min(window.screen.width, window.screen.height),
    windowWidth: window.innerWidth,
    smallScreen: isSmallScreen()
  };
}

/**
 * ¿Es un teléfono o una tableta? (Detección automática.)
 * Nunca un televisor, y nunca un PC: hace falta pantalla táctil, aunque la ventana sea pequeña.
 * @param {object} [device]  Resultado de `describeDevice`.
 * @returns {boolean}
 */
export function isMobileDevice(device = describeDevice()) {
  if ( device.tv ) return false;
  if ( device.iPadAsMac ) return true;
  const hasTouch = device.touchPoints > 0;
  if ( !hasTouch ) return false;
  if ( device.mobileUA && !device.finePointer ) return true;
  if ( device.touchPrimary && (device.shortSide <= TABLET_SHORT_SIDE) ) return true;
  return device.smallScreen && !device.finePointer;
}

/**
 * Modo pedido con `?bhd=mobile` / `?bhd=normal` / `?bhd=auto` al final del enlace.
 * Se recuerda en esta pestaña (Foundry recarga la página a veces, p. ej. al reconectar).
 * @returns {"auto"|"mobile"|"normal"|null}
 */
export function getUrlViewMode() {
  let mode = new URLSearchParams(window.location.search).get("bhd")?.toLowerCase() ?? null;
  if ( mode === "movil" || mode === "móvil" ) mode = "mobile";
  try {
    if ( VIEW_MODES.includes(mode) ) {
      if ( mode === "auto" ) sessionStorage.removeItem(URL_MODE_KEY);
      else sessionStorage.setItem(URL_MODE_KEY, mode);
      return mode;
    }
    const saved = sessionStorage.getItem(URL_MODE_KEY);
    return VIEW_MODES.includes(saved) ? saved : null;
  } catch {
    return VIEW_MODES.includes(mode) ? mode : null;
  }
}

/**
 * Modo de este dispositivo: el del enlace (`?bhd=`) o, si no hay, el ajuste "Vista de BHD Companion".
 * @returns {"auto"|"mobile"|"normal"}
 */
export function getViewMode() {
  const setting = game.settings.get(MODULE_ID, "viewMode");
  return getUrlViewMode() ?? (VIEW_MODES.includes(setting) ? setting : "auto");
}

/**
 * Olvida el `?bhd=` de esta pestaña y recarga la página sin él.
 * Se usa al cambiar de vista a mano, para que el enlace no vuelva a imponer la anterior.
 */
export function reloadWithoutUrlMode() {
  try {
    sessionStorage.removeItem(URL_MODE_KEY);
  } catch {}
  const url = new URL(window.location.href);
  if ( !url.searchParams.has("bhd") ) return window.location.reload();
  url.searchParams.delete("bhd");
  window.location.replace(url.href);
}

/**
 * ¿Este usuario en este dispositivo tiene derecho a la vista móvil?
 * No tiene en cuenta si eligió volver a la interfaz normal.
 * Requiere que los documentos estén listos (hook "setup" o posterior).
 * El GM nunca la usa (su PC y la TV, si entra como GM, siguen con Foundry normal).
 * @returns {boolean}
 */
export function canUseMobileView() {
  if ( !game.settings.get(MODULE_ID, "enabled") ) return false;
  if ( game.user.isGM ) return false;
  const mode = getViewMode();
  if ( mode === "normal" ) return false;
  if ( mode === "mobile" ) return true;
  return game.settings.get(MODULE_ID, "forceAll") || isMobileDevice();
}

/**
 * ¿Debemos mostrar la vista móvil ahora mismo?
 * @returns {boolean}
 */
export function shouldUseMobileView() {
  // Un `?bhd=mobile` del enlace manda sobre "Volver a la interfaz normal" (preferNormal).
  const urlMobile = getUrlViewMode() === "mobile";
  const result = canUseMobileView() && (urlMobile || !game.settings.get(MODULE_ID, "preferNormal"));
  if ( !game.user.isGM ) {
    console.log(`BHD Companion | Vista ${result ? "móvil" : "normal"} (modo: ${getViewMode()})`, describeDevice());
  }
  return result;
}
