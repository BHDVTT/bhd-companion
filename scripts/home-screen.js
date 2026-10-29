import { MODULE_ID } from "./constants.js";

/**
 * "Añadir a la pantalla de inicio": que la vista móvil se abra como una app (pantalla completa,
 * sin la barra del navegador, con su propio icono).
 *
 * Foundry no trae un manifiesto de app web, así que se añade uno al cargar la página. Se crea en
 * el momento (no como archivo) para poder poner la dirección completa del mundo: así funciona igual
 * en Foundry local que en The Forge. iPhone y iPad usan además las etiquetas `apple-*`.
 */

/** Color de fondo y de la barra de estado (el fondo de la vista móvil). */
const THEME_COLOR = "#121015";

/**
 * Evento de Chrome / Android que permite mostrar el botón "Instalar" propio.
 * @type {Event|null}
 */
let installPrompt = null;

/**
 * Añade el manifiesto y las etiquetas de app. Llamar en "setup" y solo en vista móvil.
 */
export function enableHomeScreenApp() {
  const icon = size => new URL(foundry.utils.getRoute(`modules/${MODULE_ID}/icons/icon-${size}.png`), window.location.origin).href;
  const manifest = {
    name: game.world.title ? `${game.world.title} · BHD` : "BHD Companion",
    short_name: "BHD",
    description: game.i18n.localize("BHD.Install.Description"),
    start_url: new URL(foundry.utils.getRoute("game"), window.location.origin).href,
    scope: new URL(foundry.utils.getRoute("/"), window.location.origin).href,
    display: "standalone",
    orientation: "portrait",
    background_color: THEME_COLOR,
    theme_color: THEME_COLOR,
    icons: [
      { src: icon(192), sizes: "192x192", type: "image/png", purpose: "any" },
      { src: icon(512), sizes: "512x512", type: "image/png", purpose: "any" }
    ]
  };
  const blob = new Blob([JSON.stringify(manifest)], { type: "application/manifest+json" });

  addHeadTag("link", { rel: "manifest", href: URL.createObjectURL(blob) });
  addHeadTag("link", { rel: "apple-touch-icon", href: icon(180) });
  addHeadTag("meta", { name: "theme-color", content: THEME_COLOR });
  addHeadTag("meta", { name: "mobile-web-app-capable", content: "yes" });
  addHeadTag("meta", { name: "apple-mobile-web-app-capable", content: "yes" });
  addHeadTag("meta", { name: "apple-mobile-web-app-title", content: "BHD" });
  addHeadTag("meta", { name: "apple-mobile-web-app-status-bar-style", content: "black" });

  // Chrome / Android: guardar el aviso de instalación para lanzarlo desde el botón de ajustes.
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    installPrompt = event;
  });
  window.addEventListener("appinstalled", () => installPrompt = null);
}

/**
 * Añade una etiqueta a <head> (o reemplaza la que ya hubiera con el mismo nombre / rel).
 * @param {string} tag
 * @param {object} attributes
 */
function addHeadTag(tag, attributes) {
  const key = attributes.rel ? `[rel="${attributes.rel}"]` : `[name="${attributes.name}"]`;
  document.head.querySelector(`${tag}${key}`)?.remove();
  const element = document.createElement(tag);
  for ( const [name, value] of Object.entries(attributes) ) element.setAttribute(name, value);
  document.head.append(element);
}

/**
 * ¿La página ya está abierta como app desde la pantalla de inicio?
 * @returns {boolean}
 */
export function isInstalled() {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator.standalone === true);
}

/**
 * Cómo instalar en este dispositivo: "installed", "prompt" (botón Instalar de Chrome), "ios" o "android".
 * @returns {string}
 */
export function getInstallMode() {
  if ( isInstalled() ) return "installed";
  if ( installPrompt ) return "prompt";
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || ((navigator.platform === "MacIntel") && (navigator.maxTouchPoints > 1));
  return ios ? "ios" : "android";
}

/**
 * Muestra el aviso de instalación de Chrome / Android.
 * @returns {Promise<boolean>}  true si el jugador aceptó.
 */
export async function promptInstall() {
  const prompt = installPrompt;
  if ( !prompt ) return false;
  installPrompt = null;   // Solo se puede usar una vez.
  prompt.prompt();
  const { outcome } = await prompt.userChoice;
  return outcome === "accepted";
}
