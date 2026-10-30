/**
 * Registro paso a paso de los usos (ataques, hechizos...) hechos desde el teléfono.
 *
 * En el teléfono casi nunca se puede abrir la consola, así que cada paso se escribe en la consola
 * del teléfono y también se manda a la consola del DM (F12 en el PC del DM), con el nombre del
 * jugador. Así se ve en qué paso se queda un ataque o un hechizo.
 */

import { MODULE_ID } from "./constants.js";

const SOCKET = `module.${MODULE_ID}`;

/**
 * Escucha los registros de los teléfonos. Se llama en "ready" en todos los clientes; solo el DM los muestra.
 */
export function registerUseLogSocket() {
  game.socket.on(SOCKET, (data, senderId) => {
    if ( (data?.type !== "useLog") || !game.user.isGM ) return;
    const name = game.users.get(senderId)?.name ?? senderId;
    const print = (data.level === "error") ? console.error : (data.level === "warn") ? console.warn : console.log;
    print(`BHD Companion | [${name}] ${data.step}`, ...(data.details ?? []));
  });
}

/**
 * Escribe un paso en la consola del teléfono y en la del DM.
 * @param {string} step  Qué está pasando, en pocas palabras.
 * @param {...*} details  Datos sencillos (texto, números, objetos pequeños).
 */
export function useLog(step, ...details) {
  write("log", step, details);
}

/** Igual que `useLog`, como aviso. */
export function useWarn(step, ...details) {
  write("warn", step, details);
}

/** Igual que `useLog`, como error. */
export function useError(step, ...details) {
  write("error", step, details);
}

/* -------------------------------------------- */

function write(level, step, details) {
  const print = (level === "error") ? console.error : (level === "warn") ? console.warn : console.log;
  print(`BHD Companion | ${step}`, ...details);
  if ( game.user.isGM || !game.users.activeGM ) return;
  try {
    game.socket.emit(SOCKET, { type: "useLog", level, step, details: details.map(toPlain) }, {
      recipients: game.users.filter(u => u.isGM && u.active).map(u => u.id)
    });
  } catch(err) {
    console.error("BHD Companion | No se pudo mandar el registro al DM", err);
  }
}

/**
 * Convierte un dato en algo que se pueda mandar por el canal (sin documentos ni ciclos).
 * @param {*} value
 */
function toPlain(value) {
  if ( value instanceof Error ) return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
  if ( (value === null) || (typeof value !== "object") ) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}
