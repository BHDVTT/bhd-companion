/**
 * Ventanas en la vista móvil: solo las que sirven en el teléfono, y de una en una.
 *
 * Se cierran al aparecer las ventanas que no forman parte de un flujo de juego: hojas de personaje u objeto,
 * registros y rastreadores (combate en ventana, paneles de otros módulos), ventanas sacadas de la barra lateral,
 * diarios, compendios, ajustes, elegir archivo... En el teléfono taparían la vista y nadie las espera.
 *
 * Se dejan:
 * - Las ventanas de dnd5e para usar y tirar (`Dialog5e`: uso de actividad, opciones de tirada, descansos) y la de
 *   elegir actividad.
 * - Las ventanas propias del módulo (clase `bhd-dialog`).
 * - Todo lo que pide una decisión al jugador: preguntas de Cauldron of Plentiful Resources / Chris's Premades
 *   (`DialogApp`, si no salen ya en el aviso de la vista), ventanas de Midi QOL (`MidiQOL.apps.*Dialog`:
 *   bonificaciones opcionales, reacciones, confirmar objetivos...), diálogos genéricos de Foundry (`DialogV2`, el
 *   `Dialog` antiguo) y otras ventanas cuyo nombre de clase acaba en "Dialog" o "Prompt". También la tirada de grupo
 *   de Epic Rolls 5e (sin marco).
 *
 * Las que llegan solas (sin que el jugador acabe de tocar la pantalla) son preguntas de un flujo: entran en la cola
 * única de preguntas (prompt-queue.js) con el estilo de "decisión" y vibración, y solo se ve la primera.
 * Las que abre el jugador con un toque salen al momento; si quedan dos a la vez, solo se ve la última.
 * Mientras no se decide, el CSS mantiene invisible cualquier ventana sin la clase `bhd-window`.
 */

import { dequeuePrompt, enqueuePrompt, isActivePrompt, onPromptQueueChange } from "./prompt-queue.js";

/** Tiempo tras un toque en el que una ventana se considera pedida por el jugador. */
const TAP_WINDOW_MS = 3000;

/** Momento del último toque en la pantalla. */
let lastTap = 0;

/** Tiradas del jugador en curso (`holdUserFlow`): sus ventanas cuentan como pedidas por él aunque tarden. */
let userFlows = 0;

/**
 * Marca una tirada que el jugador acaba de empezar (p. ej. la salvación que pidió Midi). Mientras dura, las ventanas
 * que abra (las bonificaciones opcionales de Midi: Bardic Inspiration, Lucky...) son respuesta a su toque: se ven
 * enseguida en lugar de esperar en la cola detrás de otro aviso, que es lo que dejaba la tirada parada.
 * @returns {Function}  Llamar al terminar.
 */
export function holdUserFlow() {
  userFlows++;
  let done = false;
  return () => {
    if ( done ) return;
    done = true;
    userFlows = Math.max(0, userFlows - 1);
    lastTap = Date.now();
  };
}

/**
 * ¿La ventana que se abre ahora la pidió el jugador (toque reciente o tirada suya en curso)?
 * @returns {boolean}
 */
function wasRequested() {
  return (userFlows > 0) || (Date.now() - lastTap < TAP_WINDOW_MS);
}

/** Al cargar se cierran también los diálogos genéricos (avisos de The Forge, de otros módulos...). */
let loading = true;

/**
 * Ventanas pedidas por el jugador, de la más antigua a la más nueva (la última es la visible).
 * @type {Array<ApplicationV2|Application>}
 */
const stack = [];

/**
 * Ventanas que llegaron solas (preguntas de un flujo), con su entrada en la cola de preguntas.
 * @type {Map<ApplicationV2|Application, {entry: object, vibrated: boolean}>}
 */
const queued = new Map();

/** Clases de ventana que nunca se dejan (no piden una decisión). */
const BLOCKED_NAMES = /(Sheet|Tracker|Directory|Compendium|Journal|FilePicker|Browser|Config|Settings|Popout|Explorer|Editor|Manager|Display|Panel|Tour)/;

/** Nombres de clase de ventanas que piden una decisión. */
const DECISION_NAMES = /(Dialog|Prompt)$/;

/**
 * Activa el control de ventanas. Debe llamarse en "setup" y solo en vista móvil.
 */
export function registerMobileWindows() {
  document.addEventListener("pointerdown", () => lastTap = Date.now(), { capture: true });
  Hooks.on("renderApplicationV2", onRender);
  Hooks.on("renderApplication", onRender);
  Hooks.on("closeApplicationV2", onClose);
  Hooks.on("closeApplication", onClose);
  onPromptQueueChange(() => updateVisibleWindow());
}

/**
 * Cierra las ventanas que se abrieron antes de activar el control (p. ej. durante la carga). Se llama en "ready".
 * Los diálogos genéricos que salgan en los 10 s siguientes también se cierran (avisos de la carga).
 */
export function closeStrayWindows() {
  const apps = [...foundry.applications.instances.values(), ...Object.values(ui.windows)];
  for ( const app of apps ) {
    const element = getElement(app);
    if ( element ) onRender(app, element);
  }
  setTimeout(() => loading = false, 10000);
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
 * ¿Es la tirada de grupo de Epic Rolls 5e? (Ventana sin marco a pantalla completa.)
 * @param {ApplicationV2|Application} app
 * @param {HTMLElement} element
 */
function isEpicRoll(app, element) {
  return element.classList.contains("epic-roll-5e") || (app.constructor?.name === "EpicRoll");
}

/**
 * Nombres de las clases de una ventana (la suya y las de las que hereda).
 * @param {object} app
 * @returns {string[]}
 */
function classNames(app) {
  const names = [];
  let proto = Object.getPrototypeOf(app);
  while ( proto && (proto !== Object.prototype) && (names.length < 12) ) {
    if ( proto.constructor?.name ) names.push(proto.constructor.name);
    proto = Object.getPrototypeOf(proto);
  }
  return names;
}

/**
 * Qué hacer con una ventana nueva.
 * @param {ApplicationV2|Application} app
 * @param {HTMLElement} element
 * @returns {"own"|"dnd5e"|"decision"|"blocked"}
 */
function classify(app, element) {
  if ( element.classList.contains("bhd-dialog") ) return "own";
  const dnd5eApps = globalThis.dnd5e?.applications;
  if ( dnd5eApps?.api?.Dialog5e && (app instanceof dnd5eApps.api.Dialog5e) ) return "dnd5e";
  if ( dnd5eApps?.activity?.ActivityChoiceDialog && (app instanceof dnd5eApps.activity.ActivityChoiceDialog) ) {
    return "dnd5e";
  }

  // Preguntas de Cauldron / Chris's Premades y ventanas de Midi QOL que llegan al teléfono durante un flujo.
  const known = [globalThis.chrisPremades?.DialogApp, ...Object.entries(globalThis.MidiQOL?.apps ?? {})
    .filter(([name]) => DECISION_NAMES.test(name)).map(([, cls]) => cls)];
  if ( known.some(cls => (typeof cls === "function") && (app instanceof cls)) ) return "decision";

  // Hojas de documentos: nunca.
  const sheetClasses = [foundry.applications.api.DocumentSheetV2, foundry.appv1?.api?.DocumentSheet]
    .filter(cls => typeof cls === "function");
  if ( sheetClasses.some(cls => app instanceof cls) ) return "blocked";
  if ( app.isPopout || app._original ) return "blocked";   // ventana sacada de la barra lateral

  const names = classNames(app);
  const isGenericDialog = (app instanceof foundry.applications.api.DialogV2) || (app instanceof foundry.appv1.api.Dialog);
  if ( isGenericDialog ) return loading && !wasRequested() ? "blocked" : "decision";
  const own = names[0] ?? "";
  if ( BLOCKED_NAMES.test(own) ) return "blocked";
  if ( DECISION_NAMES.test(own) ) return "decision";
  return "blocked";
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
  const element = (html instanceof HTMLElement) ? html : (html?.[0] ?? getElement(app));
  if ( !element ) return;

  // Epic Rolls: sin marco, pero es una tirada que espera al jugador → a la cola.
  if ( isEpicRoll(app, element) ) {
    if ( !queued.has(app) ) {
      queued.set(app, { entry: enqueuePrompt({ kind: "window", label: "Epic Rolls" }), vibrated: false });
      console.log("BHD Companion | Tirada de Epic Rolls en el teléfono (en la cola de preguntas)");
    }
    updateVisibleWindow();
    return;
  }

  if ( !isWindow(app) ) return;

  // Ya permitida: al redibujarse conserva su sitio (no se adelanta a otra).
  if ( stack.includes(app) || queued.has(app) ) {
    element.classList.add("bhd-window");
    updateVisibleWindow();
    return;
  }

  const kind = classify(app, element);
  if ( kind === "blocked" ) {
    element.classList.add("bhd-window-blocked");
    console.warn(`BHD Companion | Ventana cerrada en el teléfono (no pide una decisión): ${windowName(app)}`);
    if ( app instanceof foundry.applications.api.ApplicationV2 ) app.close({ animate: false }).catch(() => {});
    else app.close({ force: true });
    return;
  }

  element.classList.add("bhd-window");
  // Las ventanas que no son de dnd5e ni propias reciben el estilo compacto genérico.
  if ( !element.classList.contains("bhd-dialog") && !element.classList.contains("dnd5e2") ) {
    element.classList.add("bhd-foreign-window");
  }

  const tapped = wasRequested();
  if ( ["decision", "dnd5e"].includes(kind) && !tapped ) {
    // Llegó sola: es una pregunta de un flujo (Midi, Cauldron, otro módulo). Estilo de decisión y a la cola.
    element.classList.add("bhd-decision-window");
    queued.set(app, { entry: enqueuePrompt({ kind: "window", label: windowName(app) }), vibrated: false });
    console.log(`BHD Companion | Pregunta en ventana (en la cola): ${windowName(app)}`);
  } else {
    stack.push(app);
    console.log(`BHD Companion | Ventana mostrada en el teléfono: ${windowName(app)}`);
  }
  updateVisibleWindow();
}

/**
 * @param {ApplicationV2|Application} app
 */
function onClose(app) {
  const index = stack.indexOf(app);
  if ( index >= 0 ) stack.splice(index, 1);
  const item = queued.get(app);
  if ( item ) {
    queued.delete(app);
    dequeuePrompt(item.entry);
    console.log(`BHD Companion | Pregunta en ventana cerrada: ${windowName(app)}`);
  }
  updateVisibleWindow();
}

/**
 * Muestra solo la ventana pedida más nueva y, de las que llegaron solas, la que toca en la cola de preguntas.
 */
function updateVisibleWindow() {
  // Por si alguna se quitó sin pasar por "close".
  for ( let i = stack.length - 1; i >= 0; i-- ) {
    if ( !getElement(stack[i])?.isConnected ) stack.splice(i, 1);
  }
  for ( const [app, item] of [...queued] ) {
    if ( getElement(app)?.isConnected ) continue;
    queued.delete(app);
    dequeuePrompt(item.entry);
  }
  stack.forEach((app, index) => {
    getElement(app)?.classList.toggle("bhd-window-waiting", index < stack.length - 1);
  });
  for ( const [app, item] of queued ) {
    const active = isActivePrompt(item.entry);
    getElement(app)?.classList.toggle("bhd-window-waiting", !active);
    if ( active && !item.vibrated ) {
      item.vibrated = true;
      try {
        if ( navigator.userActivation?.hasBeenActive ?? true ) navigator.vibrate?.([200, 80, 200]);
      } catch(err) {}
    }
  }
}
