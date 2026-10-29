import { patchAbilityTemplates } from "./mobile-templates.js";

/**
 * Avisos de Foundry que no tienen sentido en la vista móvil:
 * - "Resolución demasiado baja" (Foundry pide pantallas de PC).
 * - "Estás viendo la escena X, pero el mapa está desactivado".
 */
const SILENCED_NOTIFICATIONS = new Set([
  "ERROR.RESOLUTION.Screen",
  "ERROR.RESOLUTION.Scale",
  "ERROR.RESOLUTION.Window",
  "INFO.SceneViewCanvasDisabled"
]);

/**
 * Prepara este cliente para la vista móvil. Debe llamarse en el hook "setup",
 * antes de que Foundry cree el mapa y la interfaz.
 */
export function enterMobileMode() {
  document.body.classList.add("bhd-mobile");
  disableCanvas();
  silenceDesktopNotifications();
  patchAbilityTemplates();
}

/**
 * Activa el modo "sin mapa" de Foundry solo para esta sesión: el mapa (WebGL) nunca se crea,
 * lo que ahorra batería y memoria. No se guarda nada, así que la próxima carga decide de nuevo.
 */
function disableCanvas() {
  const settings = game.settings;
  const get = settings.get;
  settings.get = function(namespace, key, options) {
    if ( (namespace === "core") && (key === "noCanvas") ) return true;
    return get.call(this, namespace, key, options);
  };
}

/**
 * Sustituye la clase de notificaciones por una que descarta los avisos de SILENCED_NOTIFICATIONS.
 * Funciona porque Foundry crea ui.notifications a partir de CONFIG.ui después del hook "setup".
 */
function silenceDesktopNotifications() {
  const Notifications = CONFIG.ui.notifications;
  CONFIG.ui.notifications = class BHDNotifications extends Notifications {
    notify(message, type, options) {
      const notification = super.notify(message, type, options);
      if ( SILENCED_NOTIFICATIONS.has(message) ) notification.remove();
      return notification;
    }
  };
}
