/**
 * Preguntas de Cauldron of Plentiful Resources (antes Chris's Premades, id `chris-premades`) en la vista móvil.
 *
 * Cómo pregunta Cauldron (código de chris-premades 1.5.x, `applications/dialog.js` y `lib/utilities/dialogUtils.js`):
 * - Todas sus preguntas ("¿Usar Sneak Attack?", elegir smite, Bardic Inspiration, Cutting Words, Agonizing Blast,
 *   arma del pacto, forma de Wild Shape...) acaban en `DialogApp.dialog(title, content, inputs, buttons, config)`,
 *   una ventana propia (ApplicationV2) que devuelve una promesa con la respuesta.
 * - Si la pregunta es para otro usuario (`userId`, p. ej. `socketUtils.firstOwner(actor)` = el dueño del personaje),
 *   la manda por su canal de socketlib (`socket.executeAsUser("dialog", userId, ...)`) y ese cliente llama a
 *   `DialogApp.dialog` con los mismos datos. La cola de reacciones (`queuedDialog`) también acaba ahí.
 * - Si no indica usuario, pregunta en el cliente que corre el flujo: con Midi QOL y la vista móvil ese es el DM
 *   (midi-remote.js ejecuta los usos del teléfono en el PC del DM).
 * - Respuesta: cerrar = `null`; botón "No" / "Cancelar" (`false`) = `{buttons: false}`; cualquier otro botón =
 *   los campos del formulario (`FormDataExtended` + `expandObject`) más `buttons` = `true` (Sí / OK) o el nombre del
 *   botón elegido (botones con imagen de `selectDocumentDialog`, `buttonDialog`...).
 *
 * Qué hace este archivo:
 * - En el teléfono, `DialogApp.dialog` se sustituye por el aviso grande de la vista (decisions.js) con los mismos
 *   textos, campos y botones, y devuelve exactamente lo mismo que la ventana. Sirve para las dos vías (local y por
 *   el canal de Cauldron). Si la pregunta trae un campo que la vista no sabe dibujar (elegir archivo), se usa la
 *   ventana original.
 * - En el DM, mientras ejecuta un uso pedido por un teléfono, las preguntas de Cauldron sin destinatario se mandan
 *   a ese teléfono con sus datos (no una copia de la ventana). Si el teléfono no contesta, salen en el DM.
 */

import { askPhone, getActiveRemoteRun, RELAY_NO_ANSWER } from "./dialog-relay.js";
import { buttonHTML, showDecision } from "./decisions.js";
import { registerSocketHandler } from "./remote-socket.js";

/** Tipos de campo de Cauldron que la vista sabe dibujar. */
const SUPPORTED = new Set(["button", "checkbox", "radio", "selectAmount", "selectOption", "selectMany", "text", "number"]);

/** Botones de abajo de Cauldron (`DialogApp#formatInputs`). */
const FOOTERS = {
  yesNo: [["CHRISPREMADES.Generic.Yes", "true", "primary"], ["CHRISPREMADES.Generic.No", "false", "plain"]],
  okCancel: [["CHRISPREMADES.Generic.Ok", "true", "primary"], ["CHRISPREMADES.Generic.Cancel", "false", "plain"]],
  ok: [["CHRISPREMADES.Generic.Ok", "true", "primary"]],
  cancel: [["CHRISPREMADES.Generic.Cancel", "false", "plain"]]
};

/**
 * Registra la función del teléfono que recibe las preguntas del DM. Llamar al cargar el módulo (antes de "init").
 */
export function registerCprDialogSocket() {
  registerSocketHandler("cprDialog", showForwardedCprDialog);
}

/**
 * Teléfono (vista móvil): las preguntas de Cauldron salen en el aviso de la vista. Llamar en "ready".
 */
export function registerCprDialogsPhone() {
  const DialogApp = globalThis.chrisPremades?.DialogApp;
  if ( typeof DialogApp?.dialog !== "function" ) return;
  if ( DialogApp.dialog.bhdWrapped ) return;
  const original = DialogApp.dialog;
  const wrapped = function(...options) {
    const spec = buildCprDecision(options);
    if ( !spec ) {
      console.log(`BHD Companion | Cauldron: pregunta "${options[0]}" con campos que la vista no dibuja; se usa su ventana`);
      return original.apply(this, options);
    }
    console.log(`BHD Companion | Cauldron pregunta en el teléfono: ${spec.title}`, summarize(options));
    return showDecision(spec).promise;
  };
  wrapped.bhdWrapped = true;
  wrapped.bhdOriginal = original;
  DialogApp.dialog = wrapped;
  console.log("BHD Companion | Cauldron: sus preguntas saldrán en el aviso de la vista");
}

/**
 * DM: durante un uso pedido por un teléfono, las preguntas de Cauldron se mandan a ese teléfono. Llamar en "ready".
 */
export function registerCprDialogsGM() {
  const DialogApp = globalThis.chrisPremades?.DialogApp;
  if ( !game.user.isGM || (typeof DialogApp?.dialog !== "function") || DialogApp.dialog.bhdWrapped ) return;
  const original = DialogApp.dialog;
  const wrapped = async function(...options) {
    const run = getActiveRemoteRun();
    if ( !run ) return original.apply(this, options);
    const tag = `BHD Companion | [${run.user.name}] ${run.label}`;
    const payload = sanitize(options);
    if ( !payload ) {
      console.warn(`${tag} | Pregunta de Cauldron que no se puede enviar; sale aquí: ${options[0]}`);
      return original.apply(this, options);
    }
    console.log(`${tag} | Pregunta de Cauldron enviada a su teléfono: ${game.i18n.localize(String(options[0] ?? ""))}`,
      summarize(options));
    const answer = await askPhone(run, "cprDialog", payload);
    if ( answer === RELAY_NO_ANSWER ) {
      console.warn(`${tag} | El teléfono no contestó la pregunta de Cauldron; sale aquí`);
      return original.apply(this, options);
    }
    console.log(`${tag} | Respuesta del jugador a Cauldron`, answer);
    return answer;
  };
  wrapped.bhdWrapped = true;
  wrapped.bhdOriginal = original;
  DialogApp.dialog = wrapped;
}

/* -------------------------------------------- */

/**
 * Teléfono: pregunta de Cauldron que manda el DM.
 * @param {Array} options  Los argumentos de `DialogApp.dialog`.
 * @returns {Promise<object|null>}
 */
async function showForwardedCprDialog(options) {
  const DialogApp = globalThis.chrisPremades?.DialogApp;
  // Con la vista móvil, `dialog` ya es el aviso de la vista; sin ella (o sin Cauldron aquí), la ventana normal.
  if ( typeof DialogApp?.dialog === "function" ) return (await DialogApp.dialog(...(options ?? []))) ?? null;
  const spec = buildCprDecision(options ?? []);
  return spec ? ((await showDecision(spec).promise) ?? null) : null;
}

/**
 * Copia que se puede mandar por socketlib (solo datos).
 * @param {Array} options
 * @returns {Array|null}
 */
function sanitize(options) {
  try {
    const [title, content, inputs, buttons, config] = options;
    return JSON.parse(JSON.stringify([title ?? "", content ?? "", inputs ?? [], buttons ?? null, config ?? {}]));
  } catch(err) {
    return null;
  }
}

/**
 * Resumen para la consola.
 * @param {Array} options
 */
function summarize([, , inputs, buttons]) {
  return {
    inputs: (inputs ?? []).map(([type, fields]) => `${type}: ${(fields ?? []).map(f => game.i18n.localize(String(f?.label ?? ""))).join(", ")}`),
    buttons
  };
}

/**
 * Prepara el aviso de la vista a partir de los datos de `DialogApp.dialog`.
 * @param {Array} options  [title, content, inputs, buttons, config]
 * @returns {import("./decisions.js").DecisionSpec|null}  null si hay campos que no se saben dibujar.
 */
export function buildCprDecision([title, content, inputs, buttons]) {
  inputs = Array.isArray(inputs) ? inputs : [];
  if ( inputs.some(group => !SUPPORTED.has(group?.[0])) ) return null;
  const localize = text => game.i18n.localize(String(text ?? ""));
  let html = content ? `<div class="bhd-cpr-content">${localize(content)}</div>` : "";
  inputs.forEach((group, index) => html += renderGroup(group, index));
  const footer = (FOOTERS[buttons] ?? []).map(([label, value, style]) => ({ label: localize(label), value, style }));
  return {
    kind: "cpr",
    title: localize(title) || "Cauldron",
    icon: "fa-solid fa-flask",
    html,
    buttons: footer,
    closable: true,
    closeValue: null,
    setup: form => setupLimits(form, inputs),
    collect: (value, form) => collectAnswer(value, form)
  };
}

/**
 * Respuesta con el mismo formato que `DialogApp#mergeResults`.
 * @param {string} value  Nombre del botón ("true", "false" u otro).
 * @param {HTMLFormElement} form
 * @returns {object}
 */
function collectAnswer(value, form) {
  if ( value === "false" ) return { buttons: false };
  const FDE = foundry.applications?.ux?.FormDataExtended ?? globalThis.FormDataExtended;
  const results = foundry.utils.expandObject(new FDE(form).object);
  results.buttons = (value === "true") ? true : value;
  return results;
}

/**
 * Imagen de Cauldron sin el "(CR 1/2)" que a veces añade a la ruta.
 * @param {string} image
 */
function cleanImage(image) {
  return image ? String(image).replace(/\s\(CR [^)]*\)$/, "") : "";
}

/**
 * Un grupo de campos de Cauldron: [tipo, campos, opciones].
 * @param {Array} group
 * @param {number} index
 * @returns {string}
 */
function renderGroup([type, fields, options], index) {
  const escape = foundry.utils.escapeHTML;
  const localize = text => escape(game.i18n.localize(String(text ?? "")));
  fields = Array.isArray(fields) ? fields : [];
  options = options ?? {};
  const rows = options.displayAsRows ? "bhd-cpr-rows" : "";
  const image = field => {
    const src = cleanImage(field.options?.image);
    return src ? `<img class="bhd-cpr-img" src="${escape(src)}" alt="">` : "";
  };
  const id = (j) => `bhd-cpr-i${index}j${j}`;
  switch ( type ) {
    case "button":
      return `<div class="bhd-cpr-group bhd-cpr-choices ${rows}">${fields.map(field => buttonHTML({
        label: game.i18n.localize(String(field.label ?? "")),
        value: String(field.name),
        img: cleanImage(field.options?.image),
        style: "choice"
      })).join("")}</div>`;
    case "checkbox":
      return `<div class="bhd-cpr-group ${rows}" data-cpr-group="${index}" data-total-max="${Number(options.totalMax) || 99}">
        ${fields.map((field, j) => `<label class="bhd-cpr-check" for="${id(j)}">
          <input type="checkbox" id="${id(j)}" name="${escape(String(field.name))}" ${field.options?.isChecked ? "checked" : ""}>
          ${image(field)}<span>${localize(field.label)}</span></label>`).join("")}</div>`;
    case "radio": {
      const radioName = escape(String(options.radioName ?? "radio"));
      return `<div class="bhd-cpr-group ${rows}">
        ${fields.map((field, j) => `<label class="bhd-cpr-check" for="${id(j)}">
          <input type="radio" id="${id(j)}" name="${radioName}" value="${escape(String(field.name))}" ${field.options?.isChecked ? "checked" : ""}>
          ${image(field)}<span>${localize(field.label)}</span></label>`).join("")}</div>`;
    }
    case "selectAmount":
      return `<div class="bhd-cpr-group ${rows}" data-cpr-group="${index}">
        ${fields.map((field, j) => {
          const min = Number(field.options?.minAmount ?? 0);
          const max = Number(field.options?.maxAmount ?? 10);
          const current = Number(field.options?.currentAmount ?? 0);
          const values = Array.fromRange(Math.max(0, max - min + 1), min);
          return `<label class="bhd-cpr-field" for="${id(j)}">${image(field)}<span>${localize(field.label)}</span>
            <select id="${id(j)}" name="${escape(String(field.name))}" data-weight="${Number(field.options?.weight ?? 1)}">
              ${values.map(v => `<option value="${v}" ${v === current ? "selected" : ""}>${v}</option>`).join("")}
            </select></label>`;
        }).join("")}</div>`;
    case "selectOption":
      return `<div class="bhd-cpr-group ${rows}">
        ${fields.map((field, j) => {
          const list = Array.isArray(field.options?.options) ? field.options.options : [];
          const current = field.options?.currentValue ?? "none";
          return `<label class="bhd-cpr-field" for="${id(j)}">${image(field)}<span>${localize(field.label)}</span>
            <select id="${id(j)}" name="${escape(String(field.name))}">
              ${list.map(o => {
                const value = (o && (typeof o === "object")) ? o.value : o;
                const label = (o && (typeof o === "object")) ? o.label : o;
                return `<option value="${escape(String(value))}" ${value === current ? "selected" : ""}>${localize(label)}</option>`;
              }).join("")}
            </select></label>`;
        }).join("")}</div>`;
    case "selectMany":
      return `<div class="bhd-cpr-group">
        ${fields.map((field, j) => {
          const selected = new Set(field.options?.value ?? []);
          const list = Array.isArray(field.options?.options) ? field.options.options : [];
          return `<label class="bhd-cpr-field bhd-cpr-many" for="${id(j)}"><span>${localize(field.label)}</span>
            <select id="${id(j)}" name="${escape(String(field.name))}" multiple size="${Math.min(6, Math.max(2, list.length))}">
              ${list.map(o => `<option value="${escape(String(o.value))}" ${selected.has(o.value) ? "selected" : ""}>${localize(o.label)}</option>`).join("")}
            </select></label>`;
        }).join("")}</div>`;
    case "text":
    case "number":
      return `<div class="bhd-cpr-group ${rows}">
        ${fields.map((field, j) => `<label class="bhd-cpr-field" for="${id(j)}">${image(field)}<span>${localize(field.label)}</span>
          <input type="${type}" id="${id(j)}" name="${escape(String(field.name))}"
                 value="${escape(String(field.options?.currentValue ?? (type === "number" ? 0 : "")))}"
                 ${type === "number" ? 'inputmode="numeric"' : ""}></label>`).join("")}</div>`;
  }
  return "";
}

/**
 * Límites de Cauldron: cuántas casillas se pueden marcar (`totalMax`) y cuánto se puede repartir entre cantidades
 * (`totalMax` con `weight`, como `DialogApp#currentMaxAmounts`).
 * @param {HTMLFormElement} form
 * @param {Array} inputs
 */
function setupLimits(form, inputs) {
  inputs.forEach(([type, , options], index) => {
    const group = form.querySelector(`[data-cpr-group="${index}"]`);
    if ( !group ) return;
    if ( type === "checkbox" ) {
      const max = Number(group.dataset.totalMax) || 99;
      const update = () => {
        const boxes = Array.from(group.querySelectorAll('input[type="checkbox"]'));
        const full = boxes.filter(b => b.checked).length >= max;
        boxes.forEach(b => b.disabled = full && !b.checked);
      };
      group.addEventListener("change", update);
      update();
    }
    else if ( (type === "selectAmount") && Number.isFinite(Number(options?.totalMax)) ) {
      const totalMax = Number(options.totalMax);
      const update = () => {
        const selects = Array.from(group.querySelectorAll("select"));
        let left = totalMax;
        selects.forEach(s => left -= Number(s.value) * Number(s.dataset.weight || 1));
        for ( const select of selects ) {
          const weight = Number(select.dataset.weight || 1);
          const currentMax = Math.floor((left + (Number(select.value) * weight)) / weight);
          for ( const option of select.options ) option.disabled = Number(option.value) > currentMax;
        }
      };
      group.addEventListener("change", update);
      update();
    }
  });
}
