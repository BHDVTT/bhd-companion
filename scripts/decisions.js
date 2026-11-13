/**
 * Aviso grande de "decisión" en la vista móvil: una pregunta de otro módulo (Cauldron of Plentiful Resources /
 * Chris's Premades, Midi QOL, dnd5e) que necesita una respuesta del jugador para que el flujo siga.
 *
 * Se dibuja dentro de la vista (no como ventana de Foundry), con vibración, y respeta la cola única de preguntas
 * (prompt-queue.js): si hay otra delante, espera. El contenido (texto, campos, botones con imagen) lo prepara quien
 * pregunta (cpr-dialogs.js, dialog-relay.js); aquí solo se muestra, se espera el toque y se devuelve lo elegido.
 *
 * Cada decisión guarda su propio trozo de página: si otra con cuenta atrás se adelanta, lo que el jugador ya
 * marcó se conserva al volver.
 */

import { MODULE_ID } from "./constants.js";
import { countWaitingPrompts, dequeuePrompt, enqueuePrompt, getActivePrompt, onPromptQueueChange } from "./prompt-queue.js";

/**
 * @typedef {object} DecisionButton
 * @property {string} label
 * @property {string} value       Lo que recibe `collect`.
 * @property {string} [img]
 * @property {string} [style]     "primary", "danger" o "plain".
 * @property {boolean} [disabled]
 */

/**
 * @typedef {object} DecisionSpec
 * @property {string} kind              Para el registro ("cpr", "relay"...).
 * @property {string} title
 * @property {string} [subtitle]
 * @property {string} [icon]            Clases de Font Awesome.
 * @property {string} [img]
 * @property {string} [html]            Contenido (texto y campos). Botones de respuesta dentro: `data-bhd-decision-value`.
 * @property {DecisionButton[]} [buttons]  Botones de abajo.
 * @property {boolean} [closable=true]  ¿Botón "Cerrar" (devuelve `closeValue`)?
 * @property {*} [closeValue=null]
 * @property {Function} [collect]       (value, form) → respuesta. Devolver `undefined` = no cerrar todavía.
 * @property {Function} [setup]         (form) → prepara los campos (límites, etc.).
 * @property {number} [deadline]        Momento (ms) en que se acaba su tiempo.
 */

/** Decisiones pendientes, por id de su entrada en la cola. @type {Map<number, object>} */
const pending = new Map();

/** Decisión que se ve ahora. */
let shown = null;

let listening = false;

/**
 * Muestra una decisión (o la deja en cola) y espera la respuesta.
 * @param {DecisionSpec} spec
 * @returns {{promise: Promise<*>, cancel: Function}}  `cancel(value)` la cierra desde fuera (p. ej. la ventana real
 *   se cerró en el DM).
 */
export function showDecision(spec) {
  listen();
  // Plazo de verdad: al acabarse se contesta solo con el valor de cierre (= "no usar" en Cauldron).
  if ( spec.timeoutMs > 0 ) spec.deadline = Date.now() + spec.timeoutMs;
  const entry = enqueuePrompt({ kind: "decision", label: `${spec.kind}: ${spec.title ?? ""}`, deadline: spec.deadline });
  let resolve;
  const promise = new Promise(r => resolve = r);
  const decision = { entry, spec, node: null, vibrated: false, done: false, resolve: null, timer: null };
  if ( spec.timeoutMs > 0 ) {
    decision.timer = setInterval(() => {
      const left = spec.deadline - Date.now();
      if ( left <= 0 ) {
        console.log(`BHD Companion | Decisión (${spec.kind}) "${spec.title}": se acabó el tiempo; no se usa`);
        decision.resolve(spec.closeValue ?? null);
        return;
      }
      updateTimer(decision, left);
    }, 250);
  }
  decision.resolve = value => {
    if ( decision.done ) return;
    decision.done = true;
    clearInterval(decision.timer);
    pending.delete(entry.id);
    if ( shown === decision ) shown = null;
    console.log(`BHD Companion | Decisión (${spec.kind}) "${spec.title}": respuesta`, value);
    resolve(value);
    dequeuePrompt(entry);
    sync();
  };
  pending.set(entry.id, decision);
  sync();
  return { promise, cancel: (value=spec.closeValue ?? null) => decision.resolve(value) };
}

/**
 * ¿Hay una decisión en pantalla? (Los botones de la vista no deben darse por trabados mientras tanto.)
 * @returns {boolean}
 */
export function isDecisionShown() {
  return !!shown;
}

/**
 * Cierra todas las decisiones pendientes con su valor de cierre (botón Reconectar).
 */
export function cancelAllDecisions() {
  for ( const decision of [...pending.values()] ) decision.resolve(decision.spec.closeValue ?? null);
}

/* -------------------------------------------- */

function listen() {
  if ( listening ) return;
  listening = true;
  onPromptQueueChange(() => sync());
}

/**
 * Contenedor del aviso, dentro de la vista móvil.
 * @returns {HTMLElement|null}
 */
function getContainer() {
  const appElement = game.modules.get(MODULE_ID)?.api?.app?.element ?? document.getElementById("bhd-mobile-app");
  const parent = appElement ?? document.body;
  let container = parent.querySelector(":scope > .bhd-decision-alert");
  if ( container ) return container;
  container = document.createElement("div");
  container.className = "bhd-decision-alert";
  container.setAttribute("role", "alertdialog");
  container.setAttribute("aria-modal", "true");
  container.hidden = true;
  container.addEventListener("click", onClick);
  container.addEventListener("submit", event => event.preventDefault());
  parent.append(container);
  return container;
}

/**
 * Muestra la decisión que toca (o nada).
 */
function sync() {
  const active = getActivePrompt();
  const decision = active ? pending.get(active.id) : null;
  const container = getContainer();
  if ( !container ) return;
  if ( !decision ) {
    shown = null;
    container.hidden = true;
    container.replaceChildren();
    return;
  }
  decision.node ??= build(decision);
  updateWaiting(decision.node);
  if ( shown !== decision ) {
    container.replaceChildren(decision.node);
    shown = decision;
    container.scrollTop = 0;
  }
  container.hidden = false;
  if ( !decision.vibrated ) {
    decision.vibrated = true;
    console.log(`BHD Companion | Decisión en pantalla (${decision.spec.kind}): ${decision.spec.title}`);
    try {
      if ( navigator.userActivation?.hasBeenActive ?? true ) navigator.vibrate?.([200, 80, 200]);
    } catch(err) {}
  }
}

/**
 * Barra y segundos de una decisión con plazo.
 * @param {object} decision
 * @param {number} left  ms que quedan.
 */
function updateTimer(decision, left) {
  const node = decision.node;
  if ( !node ) return;
  const bar = node.querySelector(".bhd-decision-bar");
  if ( bar ) bar.style.transform = `scaleX(${Math.max(0, Math.min(1, left / decision.spec.timeoutMs))})`;
  const seconds = node.querySelector(".bhd-decision-seconds");
  if ( seconds ) seconds.textContent = game.i18n.format("BHD.Decision.SecondsLeft", { seconds: Math.ceil(left / 1000) });
}

/**
 * "N preguntas más esperando".
 * @param {HTMLElement} node
 */
function updateWaiting(node) {
  const more = node.querySelector(".bhd-decision-more");
  if ( !more ) return;
  const count = countWaitingPrompts();
  more.hidden = count <= 0;
  more.textContent = count > 0 ? game.i18n.format("BHD.Decision.More", { count }) : "";
}

/**
 * Dibuja una decisión.
 * @param {object} decision
 * @returns {HTMLFormElement}
 */
function build(decision) {
  const spec = decision.spec;
  const escape = foundry.utils.escapeHTML;
  const form = document.createElement("form");
  form.className = "bhd-decision-box";
  form.dataset.decisionId = String(decision.entry.id);
  form.setAttribute("autocomplete", "off");
  const header = spec.img
    ? `<img class="bhd-decision-img" src="${escape(spec.img)}" alt="">`
    : `<i class="${escape(spec.icon ?? "fa-solid fa-circle-question")} bhd-decision-icon" aria-hidden="true"></i>`;
  const buttons = (spec.buttons ?? []).map(button => buttonHTML(button)).join("");
  form.innerHTML = `
    ${header}
    <strong class="bhd-decision-title">${escape(spec.title ?? "")}</strong>
    ${spec.subtitle ? `<span class="bhd-decision-subtitle">${escape(spec.subtitle)}</span>` : ""}
    <div class="bhd-decision-body">${spec.html ?? ""}</div>
    ${buttons ? `<div class="bhd-decision-buttons">${buttons}</div>` : ""}
    ${(spec.closable ?? true) ? `<button type="button" class="bhd-decision-close" data-bhd-decision-close>
      ${escape(spec.closeLabel ?? game.i18n.localize("BHD.Decision.Close"))}</button>` : ""}
    ${spec.timeoutMs > 0 ? `<div class="bhd-reaction-timer"><span class="bhd-reaction-bar bhd-decision-bar"></span></div>
      <span class="bhd-decision-more bhd-decision-seconds"></span>` : ""}
    <span class="bhd-decision-more" hidden></span>`;
  // Nada de scripts ni enlaces que saquen de la vista.
  form.querySelectorAll("script, iframe, object, embed").forEach(e => e.remove());
  try {
    spec.setup?.(form);
  } catch(err) {
    console.error(`BHD Companion | Decisión (${spec.kind}): error al preparar los campos`, err);
  }
  return form;
}

/**
 * Botón de respuesta.
 * @param {DecisionButton} button
 * @returns {string}
 */
export function buttonHTML(button) {
  const escape = foundry.utils.escapeHTML;
  const style = button.style ?? "plain";
  return `<button type="button" class="bhd-decision-btn bhd-decision-${escape(style)} ${button.img ? "bhd-decision-has-img" : ""}"
    data-bhd-decision-value="${escape(String(button.value))}" ${button.disabled ? "disabled" : ""}>
    ${button.img ? `<img src="${escape(button.img)}" alt="">` : ""}<span>${escape(button.label ?? "")}</span>
  </button>`;
}

/**
 * Toque dentro del aviso.
 * @param {PointerEvent} event
 */
function onClick(event) {
  const form = event.target.closest(".bhd-decision-box");
  const decision = form ? pending.get(Number(form.dataset.decisionId)) : null;
  if ( !decision ) return;
  if ( event.target.closest("[data-bhd-decision-close]") ) {
    event.preventDefault();
    decision.resolve(decision.spec.closeValue ?? null);
    return;
  }
  const button = event.target.closest("[data-bhd-decision-value]");
  if ( !button || button.disabled ) return;
  event.preventDefault();
  const value = button.dataset.bhdDecisionValue;
  let result;
  try {
    result = decision.spec.collect ? decision.spec.collect(value, form) : value;
  } catch(err) {
    console.error(`BHD Companion | Decisión (${decision.spec.kind}): error al leer la respuesta`, err);
    result = decision.spec.closeValue ?? null;
  }
  if ( result === undefined ) return;
  decision.resolve(result);
}
