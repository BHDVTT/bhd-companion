import { MODULE_ID } from "./constants.js";
import { patchAbilityTemplates } from "./mobile-templates.js";
import { registerCompactDialogs } from "./mobile-dialogs.js";
import { registerMobileWindows } from "./mobile-windows.js";
import { enableHomeScreenApp } from "./home-screen.js";

/**
 * Avisos de Foundry que no tienen sentido en la vista móvil:
 * - "Resolución demasiado baja" (Foundry pide pantallas de PC).
 * - "Estás viendo la escena X, pero el mapa está desactivado".
 * - Los de conexión perdida / recuperada (en inglés): la vista móvil tiene su propio aviso.
 * @returns {Set<string>}
 */
function getSilencedNotifications() {
  return new Set([
    "ERROR.RESOLUTION.Screen",
    "ERROR.RESOLUTION.Scale",
    "ERROR.RESOLUTION.Window",
    "INFO.SceneViewCanvasDisabled",
    "You have lost connection to the server, attempting to re-establish.",
    `${CONST.vtt} | Server connection re-established.`
  ]);
}

/**
 * Prepara este cliente para la vista móvil. Debe llamarse en el hook "setup",
 * antes de que Foundry cree el mapa y la interfaz.
 */
export function enterMobileMode() {
  document.body.classList.add("bhd-mobile");
  applyLargeText();
  disableCanvas();
  silenceDesktopNotifications();
  patchPlaylistSounds();
  patchAbilityTemplates();
  registerCompactDialogs();
  registerMobileWindows();
  enableHomeScreenApp();
}

/**
 * Letra grande: una clase en <body> que agranda todos los textos de la vista y de las ventanas.
 */
export function applyLargeText() {
  document.body.classList.toggle("bhd-large-text", game.settings.get(MODULE_ID, "largeText"));
}

/**
 * El mapa (WebGL) nunca se crea en el teléfono: ahorra batería y memoria.
 * No se toca el ajuste "Disable Game Canvas" (core.noCanvas), ni guardado ni leído: The Forge
 * sincroniza los ajustes de cliente y avisaba de una diferencia. Se hace lo mismo que Foundry hace
 * con ese ajuste activo: `Canvas#initialize` sale sin crear nada, así que `canvas.initialized`
 * y `canvas.ready` quedan en false y `Scene#view` no dibuja.
 */
function disableCanvas() {
  foundry.canvas.Canvas.prototype.initialize = function() {};

  // Lo que Foundry evita por su cuenta cuando el ajuste está activo y necesitaría el mapa:
  // la pestaña de fichas de la escena y las miniaturas de vídeo.
  const Placeables = CONFIG.ui.placeables;
  if ( Placeables ) {
    CONFIG.ui.placeables = class BHDPlaceableDirectory extends Placeables {
      _canRender() {
        return false;
      }
    };
  }
  const VideoHelper = foundry.helpers.media.VideoHelper;
  VideoHelper.prototype.createThumbnail = async function() {
    return "icons/svg/video.svg";
  };
}

/**
 * Sustituye la clase de notificaciones por una que descarta los avisos silenciados
 * (sin mostrarlos ni escribirlos en la consola).
 * Funciona porque Foundry crea ui.notifications a partir de CONFIG.ui después del hook "setup".
 */
function silenceDesktopNotifications() {
  const silenced = getSilencedNotifications();
  const Notifications = CONFIG.ui.notifications;
  CONFIG.ui.notifications = class BHDNotifications extends Notifications {
    notify(message, type, options) {
      const silence = silenced.has(message);
      const notification = super.notify(message, type, silence ? { ...options, console: false } : options);
      if ( silence ) notification.remove();
      return notification;
    }
  };
}

/**
 * Música de la partida: por defecto suena solo en la TV. En el teléfono no se descarga ni se
 * reproduce (ahorra datos, batería y memoria en teléfonos viejos), salvo que el jugador active
 * "Música en el teléfono" en los ajustes de la vista.
 */
function patchPlaylistSounds() {
  const PlaylistSound = CONFIG.PlaylistSound.documentClass;
  const sync = PlaylistSound.prototype.sync;
  PlaylistSound.prototype.sync = function() {
    if ( game.settings.get(MODULE_ID, "phoneMusic") ) return sync.call(this);
    if ( this.sound?.playing ) this.sound.stop();
  };
}

/**
 * Vuelve a aplicar el ajuste "Música en el teléfono" a lo que esté sonando en la partida.
 */
export function syncPlaylistSounds() {
  if ( game.audio.locked ) return;   // Aún no hubo un toque: Foundry lo sincroniza al primer toque.
  for ( const playlist of game.playlists ) {
    for ( const sound of playlist.sounds ) sound.sync();
  }
}
