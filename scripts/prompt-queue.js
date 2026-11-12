/**
 * Cola única de preguntas al jugador en la vista móvil: una sola a la vez.
 *
 * Durante un combate pueden llegar varias cosas juntas: una salvación que pide Midi o el chat, una reacción,
 * una pregunta de Cauldron of Plentiful Resources (Chris's Premades) o de Midi ("¿Usar Sneak Attack?", elegir
 * smite...), una ventana de Midi (bonificaciones opcionales) o una tirada de grupo de Epic Rolls. Cada una se
 * apunta aquí al llegar y solo se ve la primera; las demás esperan ocultas y salen al responder.
 *
 * Orden: primero lo que tiene cuenta atrás (la que se acaba antes), porque si espera se pierde; luego el resto
 * por orden de llegada.
 *
 * Esta cola solo decide qué se ve. Cada aviso se dibuja donde siempre (la vista, decisions.js o la ventana) y
 * se suscribe con `onPromptQueueChange` para mostrarse u ocultarse.
 */

/**
 * @typedef {object} PromptEntry
 * @property {number} id
 * @property {string} kind      "save", "reaction", "decision", "window"...
 * @property {string} label     Para el registro.
 * @property {number} at        Orden de llegada.
 * @property {number|null} deadline  Momento (ms) en que se acaba su tiempo, si tiene.
 */

/** @type {PromptEntry[]} */
const entries = [];

/** @type {Set<Function>} */
const listeners = new Set();

let counter = 0;

/** Primera de la cola la última vez que se avisó (para registrar los cambios). */
let lastActive = null;

/**
 * Apunta una pregunta nueva.
 * @param {{kind: string, label?: string, deadline?: number|null}} data
 * @returns {PromptEntry}
 */
export function enqueuePrompt({ kind, label="", deadline=null }) {
  const entry = { id: ++counter, kind, label, at: counter, deadline: Number(deadline) || null };
  entries.push(entry);
  const waiting = entries.length - 1;
  console.log(`BHD Companion | Pregunta en cola: ${kind} ${label}`.trim() + (waiting ? ` (${waiting} antes o a la vez)` : ""));
  notify();
  return entry;
}

/**
 * Quita una pregunta (respondida, cancelada o caducada).
 * @param {PromptEntry|null} entry
 */
export function dequeuePrompt(entry) {
  const index = entry ? entries.indexOf(entry) : -1;
  if ( index < 0 ) return;
  entries.splice(index, 1);
  notify();
}

/**
 * Cambia el momento en que se acaba el tiempo de una pregunta (p. ej. una salvación que empieza a contar).
 * @param {PromptEntry|null} entry
 * @param {number|null} deadline
 */
export function setPromptDeadline(entry, deadline) {
  if ( !entry || !entries.includes(entry) ) return;
  const value = Number(deadline) || null;
  if ( entry.deadline === value ) return;
  entry.deadline = value;
  notify();
}

/**
 * La pregunta que se ve ahora.
 * @returns {PromptEntry|null}
 */
export function getActivePrompt() {
  if ( !entries.length ) return null;
  return [...entries].sort((a, b) => {
    if ( a.deadline && b.deadline ) return (a.deadline - b.deadline) || (a.at - b.at);
    if ( a.deadline ) return -1;
    if ( b.deadline ) return 1;
    return a.at - b.at;
  })[0];
}

/**
 * ¿Le toca a esta pregunta verse?
 * @param {PromptEntry|null} entry
 * @returns {boolean}
 */
export function isActivePrompt(entry) {
  return !!entry && (getActivePrompt() === entry);
}

/**
 * Cuántas preguntas esperan detrás de la que se ve.
 * @returns {number}
 */
export function countWaitingPrompts() {
  return Math.max(0, entries.length - 1);
}

/**
 * ¿Hay alguna pregunta pendiente?
 * @returns {boolean}
 */
export function hasPendingPrompts() {
  return entries.length > 0;
}

/**
 * Avisa cada vez que cambia la cola (llega, sale o cambia el orden).
 * @param {Function} listener
 * @returns {Function}  Para dejar de escuchar.
 */
export function onPromptQueueChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/* -------------------------------------------- */

function notify() {
  const active = getActivePrompt();
  if ( active !== lastActive ) {
    lastActive = active;
    if ( active ) console.log(`BHD Companion | Pregunta en pantalla: ${active.kind} ${active.label}`.trim()
      + (entries.length > 1 ? ` (${entries.length - 1} esperando)` : ""));
  }
  for ( const listener of [...listeners] ) {
    try {
      listener(active);
    } catch(err) {
      console.error("BHD Companion | Error al actualizar la cola de preguntas", err);
    }
  }
}
