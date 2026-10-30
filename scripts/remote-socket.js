/**
 * Canal de socketlib del módulo (con Midi QOL, que ya trae socketlib).
 *
 * Lo usan el teléfono para pedir al DM que use algo por él (midi-remote.js) y el DM para mandar al
 * teléfono las ventanas que salen durante ese uso (dialog-relay.js). socketlib comparte el canal
 * `module.bhd-companion` con los mensajes propios (mover, registro): cada uno ignora los del otro.
 */

import { MODULE_ID } from "./constants.js";

/** Funciones que cualquier cliente puede ejecutar a petición de otro, por nombre. */
const handlers = new Map();

/** Canal de socketlib (null si socketlib no está activo). */
let socket = null;

// socketlib avisa durante "init"; este archivo se carga antes.
Hooks.once("socketlib.ready", () => {
  socket = globalThis.socketlib?.registerModule(MODULE_ID) ?? null;
  if ( !socket ) {
    console.warn("BHD Companion | socketlib no pudo registrar el canal del módulo");
    return;
  }
  for ( const [name, handler] of handlers ) socket.register(name, handler);
  console.log(`BHD Companion | Canal de socketlib listo (${[...handlers.keys()].join(", ")})`);
});

/**
 * Registra una función del canal. Llamar al cargar el módulo (antes de "init").
 * @param {string} name
 * @param {Function} handler  socketlib pone en `this.socketdata.userId` quién la pidió.
 */
export function registerSocketHandler(name, handler) {
  handlers.set(name, handler);
  socket?.register(name, handler);
}

/**
 * @returns {object|null}  El canal de socketlib, o null si no está.
 */
export function getSocket() {
  return socket;
}
