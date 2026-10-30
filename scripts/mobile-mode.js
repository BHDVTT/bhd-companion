import { MODULE_ID } from "./constants.js";
import { patchAbilityTemplates } from "./mobile-templates.js";
import { registerCompactDialogs } from "./mobile-dialogs.js";
import { registerMobileWindows } from "./mobile-windows.js";
import { enableHomeScreenApp } from "./home-screen.js";

/** Resolución del mapa oculto (1 = un píxel por píxel CSS; las pantallas retina usan 2 o 3). */
const CANVAS_RESOLUTION = 0.5;

/** Fotogramas por segundo del mapa oculto: bastan para que terminen las animaciones de las fichas. */
const CANVAS_FPS = 10;

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
  prepareHiddenCanvas();
  disableDiceSoNice();
  drawNoSequencerEffects();
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
 * ¿Este cliente está en vista móvil? (Se decide en "setup".)
 * @returns {boolean}
 */
export function isMobileView() {
  return document.body.classList.contains("bhd-mobile");
}

/**
 * Dice So Nice: los dados 3D no se tiran en el teléfono (gastarían batería y taparían la vista);
 * en la TV siguen igual. Se quitan del chat, de `showForRoll` y su lienzo se oculta por CSS.
 * No se cambian sus ajustes (The Forge los sincroniza).
 */
function disableDiceSoNice() {
  Hooks.on("diceSoNiceMessagePreProcess", (messageId, interception) => {
    interception.willTrigger3DRoll = false;
  });
  Hooks.once("ready", () => {
    const dice3d = game.dice3d;
    if ( !dice3d ) return;
    dice3d.messageHookDisabled = true;
    dice3d.showForRoll = async () => true;
  });
}

/**
 * El mapa se carga (Automated Animations y Sequencer necesitan las fichas del mapa para saber desde dónde
 * y hacia dónde va una animación; los objetivos son fichas de verdad), pero escondido detrás de la vista
 * y gastando lo mínimo:
 * - resolución baja y modo de rendimiento bajo (sin suavizado ni mipmaps, bordes de luz simples);
 * - sin animaciones de luces;
 * - una vez cargado, pocos fotogramas por segundo y no se pinta nada (`canvas.stage.renderable = false`):
 *   las fichas existen y se mueven, pero la tarjeta gráfica no dibuja ni el mapa ni los efectos de FXMaster.
 * No se cambia ningún ajuste de Foundry (The Forge los sincroniza): se sustituyen las funciones.
 */
function prepareHiddenCanvas() {
  Hooks.on("canvasConfig", config => {
    config.resolution = CANVAS_RESOLUTION;
    config.powerPreference = "low-power";
  });

  const EffectsGroup = foundry.canvas.groups.EffectsCanvasGroup;
  EffectsGroup.prototype.activateAnimation = function() {
    this.deactivateAnimation();
  };

  // Mientras el mapa se dibuja tiene que pintarse con normalidad: la niebla de guerra lee píxeles de la
  // tarjeta gráfica y espera a que se pinte un fotograma (con el mapa sin pintar o a pocos FPS, la carga
  // se quedaba esperando y la vista móvil no llegaba a abrirse). Ya cargado, deja de pintarse y baja a 10 FPS.
  Hooks.on("canvasReady", () => {
    canvas.stage.renderable = false;
    canvas.app.ticker.maxFPS = PIXI.Ticker.shared.maxFPS = PIXI.Ticker.system.maxFPS = CANVAS_FPS;
  });
  Hooks.on("canvasTearDown", () => {
    if ( canvas.stage ) canvas.stage.renderable = true;
    canvas.app.ticker.maxFPS = PIXI.Ticker.shared.maxFPS = PIXI.Ticker.system.maxFPS = 0;
  });

  // Sonidos ambientales del mapa: como la música, solo con "Música en el teléfono".
  const SoundsLayer = foundry.canvas.layers.SoundsLayer;
  const syncPositions = SoundsLayer.prototype._syncPositions;
  SoundsLayer.prototype._syncPositions = function(listeners, options) {
    return syncPositions.call(this, game.settings.get(MODULE_ID, "phoneMusic") ? listeners : [], options);
  };
}

/**
 * Sequencer (lo usa Automated Animations): el teléfono **sí manda** las animaciones a las demás pantallas
 * (TV, PC del DM), pero no las dibuja él. `Sequencer.EffectManager.play` primero las envía a los demás
 * (`executeForOthers`) y después llama a `_playEffect` para dibujarlas aquí: solo se anula ese último paso
 * (también para las animaciones que llegan de otros). No se cambian sus ajustes.
 */
function drawNoSequencerEffects() {
  Hooks.once("ready", () => {
    const effects = globalThis.Sequencer?.EffectManager;
    if ( typeof effects?._playEffect !== "function" ) return;
    effects._playEffect = async () => ({ duration: Promise.resolve(0), promise: Promise.resolve() });
  });
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
  if ( canvas?.ready ) canvas.sounds?.refresh();
}
