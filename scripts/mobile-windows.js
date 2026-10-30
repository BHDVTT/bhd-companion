/**
 * Ventanas en la vista móvil: solo las que sirven en el teléfono, y de una en una.
 *
 * Otros módulos (y Foundry) abren ventanas por su cuenta: el registro de combate en ventana,
 * paneles de combate, avisos de ajustes... En el teléfono taparían la app, así que se cierran
 * en cuanto aparecen. Se dejan:
 * - Las ventanas de dnd5e para usar y tirar (`Dialog5e`: uso de actividad, opciones de tirada,
 *   descansos) y la de elegir actividad.
 * - Las ventanas propias del módulo (clase `bhd-dialog`).
 * - Otros diálogos (`DialogV2` o el `Dialog` antiguo) solo si el jugador acaba de tocar la pantalla:
 *   son la respuesta a algo que pidió (p. ej. una confirmación de dnd5e). Los que salen solos se cierran.
 *
 * Si quedan dos ventanas permitidas a la vez, solo se ve la última; la otra vuelve al cerrarse esta.
 * Mientras no se decide, el CSS mantiene invisible cualquier ventana sin la clase `bhd-window`.
 */

/** Tiempo tras un toque en el que un diálogo se considera pedido por el jugador. */
const TAP_WINDOW_MS = 3000;

/** Momento del último toque en la pantalla. */
let lastTap = 0;

/**
 * Ventanas permitidas abiertas, de la más antigua a la más nueva (la última es la visible).
 * @type {Array<ApplicationV2|Application>}
 */
const stack = [];

/**
 * Activa el control de ventanas. Debe llamarse en "setup" y solo en vista móvil.
 */
export function registerMobileWindows() {
  document.addEventListener("pointerdown", () => lastTap = Date.now(), { capture: true });
  Hooks.on("renderApplicationV2", onRender);
  Hooks.on("renderApplication", onRender);
  Hooks.on("closeApplicationV2", onClose);
  Hooks.on("closeApplication", onClose);
}

/**
 * Cierra las ventanas que se abrieron antes de activar el control (p. ej. durante la carga).
 * Se llama en "ready".
 */
export function closeStrayWindows() {
  const apps = [...foundry.applications.instances.values(), ...Object.values(ui.windows)];
  for ( const app of apps ) {
    const element = getElement(app);
    if ( element ) onRender(app, element);
  }
}

/* -------------------------------------------- */

/**
 * @param {ApplicationV2|Application} app
 * @returns {HTMLElement|undefined}
 */
function getElement(app) {
  const element = app.element;
  return (element instanceof HTMLElement) ? element : element?.[0];
}

/**
 * ¿Es una ventana flotante? (Las partes de la interfaz, como el chat o la barra lateral, no lo son.)
 * @param {ApplicationV2|Application} app
 */
function isWindow(app) {
  if ( app instanceof foundry.applications.api.ApplicationV2 ) return app.hasFrame;
  return app.popOut === true;
}

/**
 * ¿Esta ventana puede quedarse abierta en el teléfono?
 * @param {ApplicationV2|Application} app
 * @param {HTMLElement} element
 */
function isAllowed(app, element) {
  if ( element.classList.contains("bhd-dialog") ) return true;
  const dnd5eApps = globalThis.dnd5e?.applications;
  if ( dnd5eApps?.api?.Dialog5e && (app instanceof dnd5eApps.api.Dialog5e) ) return true;
  if ( dnd5eApps?.activity?.ActivityChoiceDialog && (app instanceof dnd5eApps.activity.ActivityChoiceDialog) ) {
    return true;
  }
  const isDialog = (app instanceof foundry.applications.api.DialogV2) || (app instanceof foundry.appv1.api.Dialog);
  return isDialog && (Date.now() - lastTap < TAP_WINDOW_MS);
}

/**
 * Nombre de una ventana para el registro.
 * @param {ApplicationV2|Application} app
 */
function windowName(app) {
  return `${app.constructor?.name ?? "?"} (${app.id ?? app.appId ?? "?"})`;
}

/**
 * Se ejecuta cada vez que se dibuja una aplicación.
 * @param {ApplicationV2|Application} app
 * @param {HTMLElement|jQuery} html
 */
function onRender(app, html) {
  if ( !isWindow(app) ) return;
  const element = (html instanceof HTMLElement) ? html : (html?.[0] ?? getElement(app));
  if ( !element ) return;

  // Ya permitida: al redibujarse conserva su sitio en la pila (no se adelanta a otra).
  if ( stack.includes(app) ) {
    element.classList.add("bhd-window");
    updateVisibleWindow();
    return;
  }

  if ( !isAllowed(app, element) ) {
    element.classList.add("bhd-window-blocked");
    console.warn(`BHD Companion | Ventana cerrada en el teléfono: ${windowName(app)}`);
    if ( app instanceof foundry.applications.api.ApplicationV2 ) app.close({ animate: false }).catch(() => {});
    else app.close({ force: true });
    return;
  }

  element.classList.add("bhd-window");
  // Las ventanas que no son de dnd5e ni propias reciben el estilo compacto genérico.
  if ( !element.classList.contains("bhd-dialog") && !element.classList.contains("dnd5e2") ) {
    element.classList.add("bhd-foreign-window");
  }
  stack.push(app);
  console.log(`BHD Companion | Ventana mostrada en el teléfono: ${windowName(app)}`);
  updateVisibleWindow();
}

/**
 * @param {ApplicationV2|Application} app
 */
function onClose(app) {
  const index = stack.indexOf(app);
  if ( index < 0 ) return;
  stack.splice(index, 1);
  updateVisibleWindow();
}

/**
 * Muestra solo la ventana más nueva; las demás esperan ocultas.
 */
function updateVisibleWindow() {
  // Por si alguna se quitó sin pasar por "close".
  for ( let i = stack.length - 1; i >= 0; i-- ) {
    if ( !getElement(stack[i])?.isConnected ) stack.splice(i, 1);
  }
  stack.forEach((app, index) => {
    getElement(app)?.classList.toggle("bhd-window-waiting", index < stack.length - 1);
  });
}
