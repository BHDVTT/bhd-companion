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

/* -------------------------------------------- */

/** Peticiones al DM sin respuesta todavía: al cortarse la conexión se contestan con un error. */
const pendingCalls = new Set();

// Si se corta la conexión, socketlib nunca entrega la respuesta: quien espera recibe "ConnectionLost".
Hooks.once("ready", () => {
  game.socket?.on("disconnect", () => cancelPendingCalls("ConnectionLost"));
});

/**
 * Llama a una función en el cliente del DM, con tiempo límite. Nunca se queda esperando para siempre ni lanza:
 * devuelve lo del DM o `{ ok: false, reason }` ("NoSocketlib", "NoGM", "Timeout", "ConnectionLost",
 * "GMOutdated", "Error").
 * @param {string} name
 * @param {object} data
 * @param {number} timeout  ms
 * @returns {Promise<object>}
 */
export function callGM(name, data, timeout) {
  if ( !socket ) return Promise.resolve({ ok: false, reason: "NoSocketlib" });
  if ( !game.users.activeGM ) return Promise.resolve({ ok: false, reason: "NoGM" });
  return new Promise(resolve => {
    const call = { finish: null, timer: null };
    call.finish = result => {
      if ( !pendingCalls.has(call) ) return;
      pendingCalls.delete(call);
      clearTimeout(call.timer);
      resolve(result);
    };
    pendingCalls.add(call);
    call.timer = setTimeout(() => {
      console.warn(`BHD Companion | El DM no contestó "${name}" en ${Math.round(timeout / 1000)} s`);
      call.finish({ ok: false, reason: "Timeout" });
    }, timeout);
    socket.executeAsGM(name, data).then(call.finish, err => {
      // El DM tiene una versión vieja del módulo (no conoce la función): que recargue.
      const unregistered = err instanceof (globalThis.socketlib?.errors?.SocketlibUnregisteredHandlerError ?? class {});
      call.finish({ ok: false, reason: unregistered ? "GMOutdated" : "Error", error: err?.message ?? String(err) });
    });
  });
}

/**
 * Contesta con un error todas las peticiones al DM que siguen esperando (conexión cortada o "Reconectar").
 * @param {string} [reason="ConnectionLost"]
 */
export function cancelPendingCalls(reason="ConnectionLost") {
  for ( const call of [...pendingCalls] ) call.finish({ ok: false, reason });
}
