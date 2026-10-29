/**
 * Reconexión automática en la vista móvil.
 *
 * Foundry, por sí solo, intenta reconectar unas 10 veces en ~5 segundos y, si no lo consigue,
 * manda al jugador a una página de error. En una tienda el Wi-Fi puede caerse un rato o el
 * teléfono puede quedarse bloqueado, así que en la vista móvil:
 * - se reintenta sin límite (cada vez más espaciado, hasta cada 5 segundos);
 * - al volver a la página (desbloquear el teléfono) o al volver la red, se reintenta en el acto;
 * - mientras no hay conexión, un aviso tapa la vista para que no se toquen botones que no harían nada.
 * Al reconectar, Foundry recarga la página él mismo si estuvo desconectado 5 segundos o más,
 * así todo vuelve a estar al día.
 */

/** Espera antes del primer reintento y máxima entre reintentos (ms). */
const RECONNECT_DELAY = 1000;
const RECONNECT_DELAY_MAX = 5000;

/** Tras un cierre del servidor, socket.io no reintenta solo: lo hacemos nosotros pasado este tiempo (ms). */
const SERVER_CLOSE_RETRY = 2000;

/**
 * Activa la reconexión automática y el aviso "Sin conexión". Llamar en "ready" y solo en vista móvil.
 */
export function watchConnection() {
  const socket = game.socket;
  const manager = socket?.io;
  if ( !manager ) return;
  manager.reconnectionAttempts(Infinity);
  manager.reconnectionDelay(RECONNECT_DELAY);
  manager.reconnectionDelayMax(RECONNECT_DELAY_MAX);

  const overlay = createOverlay();
  let unloading = false;
  window.addEventListener("beforeunload", () => unloading = true);

  const reconnect = () => {
    if ( !socket.connected ) socket.connect();
  };

  socket.on("disconnect", reason => {
    if ( unloading ) return;
    showOverlay(overlay, "BHD.Connection.Lost");
    if ( reason === "io server disconnect" ) setTimeout(reconnect, SERVER_CLOSE_RETRY);
  });
  manager.on("reconnect_attempt", attempt => {
    showOverlay(overlay, "BHD.Connection.Lost", game.i18n.format("BHD.Connection.Attempt", { attempt }));
  });
  manager.on("reconnect", () => {
    showOverlay(overlay, "BHD.Connection.Back");
    setTimeout(() => {
      if ( socket.connected ) overlay.hidden = true;
    }, 1500);
  });

  // Al desbloquear el teléfono o volver el Wi-Fi no hace falta esperar al siguiente reintento.
  document.addEventListener("visibilitychange", () => {
    if ( document.visibilityState === "visible" ) reconnect();
  });
  window.addEventListener("online", reconnect);
}

/**
 * Crea el aviso "Sin conexión" (oculto). Va directamente en <body> para quedar encima de todo,
 * también de las ventanas de dnd5e.
 * @returns {HTMLElement}
 */
function createOverlay() {
  const overlay = document.createElement("div");
  overlay.className = "bhd-offline";
  overlay.setAttribute("role", "alertdialog");
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="bhd-offline-box">
      <i class="fa-solid fa-wifi bhd-offline-icon" aria-hidden="true"></i>
      <strong class="bhd-offline-title"></strong>
      <span class="bhd-offline-hint">${game.i18n.localize("BHD.Connection.Hint")}</span>
      <span class="bhd-offline-attempt"></span>
      <button type="button" class="bhd-offline-reload">
        <i class="fa-solid fa-rotate-right" aria-hidden="true"></i> ${game.i18n.localize("BHD.Connection.Reload")}
      </button>
    </div>`;
  overlay.querySelector(".bhd-offline-reload").addEventListener("click", () => window.location.reload());
  document.body.append(overlay);
  return overlay;
}

/**
 * Muestra el aviso con un título y, si se da, el número de intento.
 * @param {HTMLElement} overlay
 * @param {string} titleKey
 * @param {string} [attempt]
 */
function showOverlay(overlay, titleKey, attempt="") {
  const back = titleKey === "BHD.Connection.Back";
  overlay.classList.toggle("bhd-online", back);
  overlay.querySelector(".bhd-offline-title").textContent = game.i18n.localize(titleKey);
  overlay.querySelector(".bhd-offline-attempt").textContent = attempt;
  overlay.hidden = false;
}
