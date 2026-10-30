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
  // Modo ligero (aparatos lentos): sin mapa; los usos de objetos los hace el PC del DM.
  if ( isLightMode() ) disableCanvas();
  else prepareHiddenCanvas();
  disableDesktopEffects();
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
 * ¿Modo ligero? Solo en vista móvil: el ajuste del teléfono "lightMode".
 * @returns {boolean}
 */
export function isLightMode() {
  return isMobileView() && game.settings.get(MODULE_ID, "lightMode");
}

/**
 * El mapa se carga (Midi QOL y otros módulos necesitan las fichas del mapa: posiciones, visión,
 * objetivos), pero escondido detrás de la vista y gastando lo mínimo:
 * - resolución baja y modo de rendimiento bajo (sin suavizado ni mipmaps, bordes de luz simples);
 * - pocos fotogramas por segundo;
 * - sin animaciones de luces;
 * - no se pinta nada (`canvas.stage.renderable = false`): las fichas existen y se mueven, pero la
 *   tarjeta gráfica no dibuja ni el mapa ni los efectos de FXMaster o Sequencer.
 * No se cambia ningún ajuste de Foundry (The Forge los sincroniza): se sustituyen las funciones.
 */
function prepareHiddenCanvas() {
  Hooks.on("canvasConfig", config => {
    config.resolution = CANVAS_RESOLUTION;
    config.powerPreference = "low-power";
  });

  const Canvas = foundry.canvas.Canvas;
  const configurePerformance = Canvas.prototype._configurePerformanceMode;
  Canvas.prototype._configurePerformanceMode = function() {
    const settings = configurePerformance.call(this);
    Object.assign(settings, {
      mode: CONST.CANVAS_PERFORMANCE_MODES.LOW,
      mipmap: "OFF",
      msaa: false,
      smaa: false,
      fps: CANVAS_FPS,
      lightSoftEdges: false
    });
    PIXI.BaseTexture.defaultOptions.mipmap = PIXI.MIPMAP_MODES.OFF;
    this.app.ticker.maxFPS = PIXI.Ticker.shared.maxFPS = PIXI.Ticker.system.maxFPS = CANVAS_FPS;
    return this.performance = settings;
  };

  const EffectsGroup = foundry.canvas.groups.EffectsCanvasGroup;
  EffectsGroup.prototype.activateAnimation = function() {
    this.deactivateAnimation();
  };

  const hideStage = () => {
    if ( canvas.stage ) canvas.stage.renderable = false;
  };
  Hooks.on("canvasInit", hideStage);
  Hooks.on("canvasReady", hideStage);

  // Sonidos ambientales del mapa: como la música, solo con "Música en el teléfono".
  const SoundsLayer = foundry.canvas.layers.SoundsLayer;
  const syncPositions = SoundsLayer.prototype._syncPositions;
  SoundsLayer.prototype._syncPositions = function(listeners, options) {
    return syncPositions.call(this, game.settings.get(MODULE_ID, "phoneMusic") ? listeners : [], options);
  };
}

/**
 * Efectos de otros módulos que en el teléfono no se ven y gastarían batería:
 * - Dice So Nice: dados 3D (se quitan del chat, de `showForRoll` y su lienzo se oculta por CSS).
 * - Sequencer: no se reproducen efectos en este aparato (sí en la TV).
 * FXMaster dibuja en el mapa, que ya no se pinta. No se cambian sus ajustes (The Forge los sincroniza).
 */
function disableDesktopEffects() {
  Hooks.on("diceSoNiceMessagePreProcess", (messageId, interception) => {
    interception.willTrigger3DRoll = false;
  });
  Hooks.once("ready", () => {
    const dice3d = game.dice3d;
    if ( dice3d ) {
      dice3d.messageHookDisabled = true;
      dice3d.showForRoll = async () => true;
    }
    const effects = globalThis.Sequencer?.EffectManager;
    if ( typeof effects?._playEffect === "function" ) {
      effects._playEffect = async () => ({ duration: Promise.resolve(0), promise: Promise.resolve() });
    }
  });
}

/**
 * Modo ligero: el mapa (WebGL) no se crea en el teléfono: ahorra batería y memoria.
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
  if ( canvas?.ready ) canvas.sounds?.refresh();
}
