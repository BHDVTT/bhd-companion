/**
 * Ventanas que salen en el PC del DM mientras usa algo por un jugador (con Midi QOL).
 *
 * Con Midi activo, el DM ejecuta los ataques, hechizos y rasgos que piden los teléfonos (midi-remote.js).
 * Si durante ese uso Midi, Chris's Premades o dnd5e abren una ventana para elegir algo (un truco, un arma
 * de pacto, un tipo de daño, una bonificación opcional, el nivel...), la ventana no se ve en el PC del DM:
 * se copia (texto, campos y botones tal como los dibujó el módulo) y se manda al teléfono del jugador.
 * Lo que el jugador elige vuelve al DM y se aplica a la ventana real (mismos campos, mismo botón).
 * Si el teléfono no contesta (desconectado), la ventana aparece en el PC del DM para no dejar el uso colgado.
 *
 * No se reenvían: las ventanas que el DM abre él mismo (un toque suyo en los últimos segundos), las
 * reacciones de Midi (son de las criaturas del DM) ni las ventanas de otro actor que no sea el del jugador.
 */

import { getSocket, registerSocketHandler } from "./remote-socket.js";

const { DialogV2 } = foundry.applications.api;

/** Tiempo tras un toque del DM en el que una ventana nueva se considera suya (no se reenvía). */
const GM_TAP_MS = 1500;

/** Si tras aplicar la respuesta la ventana sigue abierta sin redibujarse, se muestra al DM tras este tiempo. */
const STUCK_MS = 2500;

/** Ventanas de Midi QOL que pueden salir durante un uso y son del jugador (las reacciones van aparte). */
const MIDI_DIALOGS = ["MidiActivityChoiceDialog", "MidiRollChoiceDialog", "RollModifyDialog", "TargetConfirmationDialog"];

/** Botones que eligen una respuesta (los demás, como + / −, no se copian). */
const CHOICE_SELECTOR = [
  'button[type="submit"]', "footer button", ".dialog-buttons button", "button.dialog-button", "button[data-button]"
].join(", ");

/** Campos de formulario que se copian y se devuelven (en el mismo orden en los dos lados). */
const FIELD_SELECTOR = "input[name], select[name], textarea[name]";

/**
 * Usos remotos en curso en este cliente (del DM), del más antiguo al más nuevo.
 * @type {{user: User, actor: Actor, label: string}[]}
 */
const runs = [];

/** Ventanas ya enviadas a un teléfono (no se envían otra vez al redibujarse). */
const relayed = new WeakSet();

/** Último toque del DM en su pantalla. */
let lastGmTap = 0;

/**
 * Registra la función del teléfono (mostrar una ventana del DM) y, en el DM, el reenvío.
 * Llamar al cargar el módulo (antes de "init").
 */
export function registerDialogRelay() {
  registerSocketHandler("relayDialog", showRelayedDialog);
  Hooks.once("ready", () => {
    if ( !game.user.isGM ) return;
    document.addEventListener("pointerdown", () => lastGmTap = Date.now(), { capture: true });
    Hooks.on("renderApplicationV2", onGmRender);
    Hooks.on("renderApplication", onGmRender);
  });
}

/**
 * Empieza un uso remoto: las ventanas que salgan ahora van al teléfono de este jugador.
 * @param {User} user
 * @param {Actor} actor
 * @param {string} label  Para el registro.
 * @returns {object}  Lo que hay que pasar a `endRemoteRun`.
 */
export function startRemoteRun(user, actor, label) {
  const run = { user, actor, label };
  runs.push(run);
  return run;
}

/**
 * Termina un uso remoto.
 * @param {object} run
 */
export function endRemoteRun(run) {
  const index = runs.indexOf(run);
  if ( index >= 0 ) runs.splice(index, 1);
}

/**
 * ¿Se está usando algo de este actor por un jugador ahora mismo? (Áreas e invocaciones sin clic.)
 * @param {Actor} [actor]  Sin actor: cualquier uso remoto.
 * @returns {boolean}
 */
export function isRemoteRun(actor) {
  if ( !actor ) return runs.length > 0;
  return runs.some(run => sameActor(run.actor, actor));
}

/* -------------------------------------------- */
/*  Lado del DM                                 */
/* -------------------------------------------- */

/**
 * @param {Actor} a
 * @param {Actor} b
 */
function sameActor(a, b) {
  return !!a && !!b && ((a === b) || (a.uuid === b.uuid) || (a.id === b.id));
}

/**
 * @param {ApplicationV2|Application} app
 * @returns {HTMLElement|null}
 */
function getElement(app, html) {
  if ( html instanceof HTMLElement ) return html;
  if ( html?.[0] instanceof HTMLElement ) return html[0];
  const element = app.element;
  return (element instanceof HTMLElement) ? element : (element?.[0] ?? null);
}

/**
 * Actor del que trata una ventana, si se sabe (ventana de uso, de tirada, hoja...).
 * @param {ApplicationV2|Application} app
 * @returns {Actor|null}
 */
function getRelatedActor(app) {
  const subject = app.config?.subject;
  const document = app.document;
  const candidates = [
    app.activity?.actor, app.item?.actor, subject?.actor, subject,
    document?.actor, document, app.actor
  ];
  return candidates.find(candidate => candidate instanceof Actor) ?? null;
}

/**
 * ¿Esta ventana es una pregunta del uso remoto (y no algo del DM)?
 * @param {ApplicationV2|Application} app
 * @param {object} run
 */
function isRelayable(app, run) {
  const isFramed = (app instanceof foundry.applications.api.ApplicationV2) ? app.hasFrame : (app.popOut === true);
  if ( !isFramed ) return false;
  const midiApps = globalThis.MidiQOL?.apps ?? {};
  if ( midiApps.ReactionDialog && (app instanceof midiApps.ReactionDialog) ) return false;
  const related = getRelatedActor(app);
  if ( related && !sameActor(related, run.actor) ) return false;
  const classes = [
    DialogV2,
    foundry.appv1?.api?.Dialog,
    globalThis.chrisPremades?.DialogApp,
    globalThis.dnd5e?.applications?.api?.Dialog5e,
    ...MIDI_DIALOGS.map(name => midiApps[name])
  ].filter(cls => typeof cls === "function");
  return classes.some(cls => app instanceof cls);
}

/**
 * Hook de dibujo de ventanas en el PC del DM.
 * @param {ApplicationV2|Application} app
 * @param {HTMLElement|jQuery} html
 */
function onGmRender(app, html) {
  const run = runs.at(-1);
  if ( !run || relayed.has(app) ) return;
  if ( Date.now() - lastGmTap < GM_TAP_MS ) return;
  if ( !isRelayable(app, run) ) return;
  const element = getElement(app, html);
  if ( !element ) return;
  relayed.add(app);
  element.classList.add("bhd-relayed");
  relay(app, element, run).catch(err => {
    console.error(`BHD Companion | [${run.user.name}] Error al reenviar la ventana al teléfono`, err);
    element.classList.remove("bhd-relayed");
  });
}

/**
 * Manda la ventana al teléfono, espera la respuesta y la aplica a la ventana real.
 * @param {ApplicationV2|Application} app
 * @param {HTMLElement} element
 * @param {object} run
 */
async function relay(app, element, run) {
  const snapshot = takeSnapshot(app, element);
  const tag = `BHD Companion | [${run.user.name}] ${run.label}`;
  console.log(`${tag} | Ventana enviada a su teléfono: ${snapshot.title}`, snapshot.buttons.map(b => b.label));

  let answer;
  try {
    answer = await getSocket().executeAsUser("relayDialog", run.user.id, snapshot);
  } catch(err) {
    console.warn(`${tag} | El teléfono no contestó; la ventana se muestra aquí`, err);
    element.classList.remove("bhd-relayed");
    return;
  }
  if ( !element.isConnected ) {
    console.log(`${tag} | La ventana ya se había cerrado: ${snapshot.title}`);
    return;
  }
  if ( !answer ) {
    console.log(`${tag} | El jugador cerró la ventana sin elegir: ${snapshot.title}`);
    if ( app instanceof foundry.applications.api.ApplicationV2 ) await app.close();
    else await app.close({ force: true });
    return;
  }

  const root = element.querySelector(".window-content") ?? element;
  applyFields(root, answer.fields ?? []);
  const button = root.querySelector(`[data-bhd-choice="${answer.button}"]`);
  console.log(`${tag} | Respuesta del jugador: ${snapshot.buttons[answer.button]?.label ?? "?"}`, answer.fields);
  if ( !button ) {
    console.warn(`${tag} | No se encontró el botón elegido; la ventana se muestra aquí`);
    element.classList.remove("bhd-relayed");
    return;
  }
  // Si la ventana se redibuja con otra pregunta, se vuelve a mandar al teléfono.
  relayed.delete(app);
  button.click();
  setTimeout(() => {
    if ( element.isConnected && !relayed.has(app) ) {
      console.warn(`${tag} | La ventana sigue abierta tras la respuesta; se muestra aquí: ${snapshot.title}`);
      element.classList.remove("bhd-relayed");
    }
  }, STUCK_MS);
}

/**
 * Copia de la ventana para el teléfono: título, contenido (sin botones ni scripts) con los valores
 * actuales de los campos, y los botones que dan la respuesta.
 * @param {ApplicationV2|Application} app
 * @param {HTMLElement} element
 * @returns {{title: string, html: string, buttons: {label: string}[]}}
 */
function takeSnapshot(app, element) {
  const root = element.querySelector(".window-content") ?? element;
  const choices = Array.from(root.querySelectorAll(CHOICE_SELECTOR));
  choices.forEach((button, index) => button.dataset.bhdChoice = String(index));

  const clone = root.cloneNode(true);
  clone.querySelectorAll("[data-bhd-choice], button, script, iframe, object, embed, link, style").forEach(e => e.remove());
  for ( const el of clone.querySelectorAll("*") ) {
    for ( const { name } of Array.from(el.attributes) ) {
      if ( name.startsWith("on") || (name === "data-action") ) el.removeAttribute(name);
    }
  }
  // cloneNode copia los atributos, no lo que el usuario cambió: se pasan los valores actuales.
  const fields = Array.from(root.querySelectorAll(FIELD_SELECTOR));
  Array.from(clone.querySelectorAll(FIELD_SELECTOR)).forEach((copy, index) => {
    const field = fields[index];
    if ( !field ) return;
    if ( (copy.type === "checkbox") || (copy.type === "radio") ) copy.toggleAttribute("checked", field.checked);
    else if ( copy.tagName === "SELECT" ) {
      Array.from(copy.options).forEach((option, i) => option.toggleAttribute("selected", !!field.options[i]?.selected));
    }
    else if ( copy.tagName === "TEXTAREA" ) copy.textContent = field.value;
    else copy.setAttribute("value", field.value);
  });

  const title = app.title || app.options?.window?.title || element.querySelector(".window-title")?.textContent || "";
  return {
    title: game.i18n.localize(String(title)).trim(),
    html: clone.innerHTML,
    buttons: choices.map(button => ({ label: buttonLabel(button), disabled: button.disabled }))
  };
}

/**
 * Texto de un botón (o su descripción si solo tiene un icono).
 * @param {HTMLButtonElement} button
 */
function buttonLabel(button) {
  const text = button.textContent.replace(/\s+/g, " ").trim();
  return text || button.getAttribute("aria-label") || button.dataset.tooltip || button.title || button.name || "OK";
}

/**
 * Pone en la ventana real los valores que eligió el jugador (mismo orden de campos).
 * @param {HTMLElement} root
 * @param {{value: string|string[], checked: boolean}[]} answers
 */
function applyFields(root, answers) {
  const fields = Array.from(root.querySelectorAll(FIELD_SELECTOR));
  answers.forEach((answer, index) => {
    const field = fields[index];
    if ( !field || !answer || (field.type === "hidden") ) return;
    if ( (field.type === "checkbox") || (field.type === "radio") ) field.checked = !!answer.checked;
    else if ( field.multiple && Array.isArray(answer.value) ) {
      for ( const option of field.options ) option.selected = answer.value.includes(option.value);
    }
    else field.value = answer.value ?? "";
  });
}

/* -------------------------------------------- */
/*  Lado del teléfono                           */
/* -------------------------------------------- */

/**
 * Muestra en el teléfono una ventana que llegó del DM y devuelve lo elegido.
 * @this {{socketdata: {userId: string}}}
 * @param {{title: string, html: string, buttons: {label: string, disabled: boolean}[]}} snapshot
 * @returns {Promise<{button: number, fields: object[]}|null>}  Null si se cerró sin elegir.
 */
async function showRelayedDialog(snapshot) {
  console.log(`BHD Companion | Pregunta del DM en el teléfono: ${snapshot.title}`, snapshot.buttons.map(b => b.label));
  try {
    if ( navigator.userActivation?.hasBeenActive ?? true ) navigator.vibrate?.([120, 80, 120]);
  } catch(err) {}

  const buttons = [];
  snapshot.buttons.forEach((choice, index) => {
    if ( choice.disabled ) return;
    buttons.push({
      action: `bhdChoice${index}`,
      label: choice.label,
      default: !buttons.length,
      callback: (event, button) => ({ button: index, fields: collectFields(button.form) })
    });
  });
  if ( !buttons.length ) buttons.push({ action: "close", label: "BHD.Actions.Close", callback: () => null });

  const result = await DialogV2.wait({
    window: { title: snapshot.title || "BHD.Relay.Title" },
    classes: ["bhd-dialog", "bhd-relay-dialog"],
    content: `<div class="bhd-relay-content">${snapshot.html}</div>`,
    buttons,
    rejectClose: false
  });
  const answer = (result && (typeof result === "object")) ? result : null;
  console.log(`BHD Companion | Respuesta enviada al DM: ${answer ? (snapshot.buttons[answer.button]?.label ?? "?") : "(cerrada)"}`);
  return answer;
}

/**
 * Valores de los campos copiados, en el orden de la ventana del DM.
 * @param {HTMLFormElement} form
 * @returns {{value: string|string[], checked: boolean}[]}
 */
function collectFields(form) {
  const container = form?.querySelector(".bhd-relay-content");
  if ( !container ) return [];
  return Array.from(container.querySelectorAll(FIELD_SELECTOR)).map(field => ({
    value: field.multiple ? Array.from(field.selectedOptions).map(o => o.value) : field.value,
    checked: !!field.checked
  }));
}
