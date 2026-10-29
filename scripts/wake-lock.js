import { MODULE_ID } from "./constants.js";

/**
 * Pantalla siempre encendida mientras la vista móvil está abierta (Screen Wake Lock API).
 *
 * El navegador suelta el bloqueo cada vez que la página deja de verse (cambiar de app, bloquear
 * el teléfono) o si no hubo un toque antes; por eso se vuelve a pedir al volver a la página y en
 * cada toque. Solo funciona con HTTPS (The Forge) o en localhost; en Safari desde iOS 16.4.
 */

/** @type {WakeLockSentinel|null} */
let sentinel = null;

/** ¿Hay una petición en curso? */
let requesting = false;

/** ¿Ya se escuchan los eventos de la página? */
let listening = false;

/**
 * ¿Este navegador puede mantener la pantalla encendida?
 * @returns {boolean}
 */
export function canKeepAwake() {
  return ("wakeLock" in navigator) && window.isSecureContext;
}

/**
 * Empieza (o deja) de mantener la pantalla encendida según el ajuste `keepAwake`.
 */
export function updateWakeLock() {
  if ( !canKeepAwake() ) return;
  if ( !listening ) {
    listening = true;
    document.addEventListener("visibilitychange", requestWakeLock);
    document.addEventListener("pointerdown", requestWakeLock, { passive: true });
  }
  if ( game.settings.get(MODULE_ID, "keepAwake") ) requestWakeLock();
  else {
    sentinel?.release().catch(() => {});
    sentinel = null;
  }
}

/**
 * Pide el bloqueo si hace falta. Los fallos (sin toque previo, ahorro de batería) no son errores:
 * se vuelve a intentar con el siguiente toque.
 */
async function requestWakeLock() {
  if ( sentinel || requesting || (document.visibilityState !== "visible") ) return;
  if ( !game.settings.get(MODULE_ID, "keepAwake") ) return;
  requesting = true;
  try {
    const lock = await navigator.wakeLock.request("screen");
    // Si el jugador lo desactivó mientras se pedía.
    if ( !game.settings.get(MODULE_ID, "keepAwake") ) {
      lock.release().catch(() => {});
      return;
    }
    lock.addEventListener("release", () => {
      if ( sentinel === lock ) sentinel = null;
    });
    sentinel = lock;
  } catch(err) {
    // El navegador no lo permite ahora mismo; no pasa nada.
  } finally {
    requesting = false;
  }
}
