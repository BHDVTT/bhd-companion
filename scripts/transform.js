/**
 * Volver a la forma original (Wild Shape, Polymorph...) desde el teléfono.
 *
 * Revertir es `Actor5e#revertOriginalForm` de dnd5e: necesita el mapa (fichas de la escena) y borra el actor
 * transformado, cosas que un jugador sin mapa no puede hacer. Por eso, si hay un DM conectado, se le pide a él
 * (canal de socketlib del módulo); comprueba que el jugador es dueño de esa forma y llama a la misma función.
 * Sin DM, se intenta en el teléfono (dnd5e avisa si no se puede).
 */

import { callGM, registerSocketHandler } from "./remote-socket.js";

/** Tiempo máximo de espera al DM (ms). */
const REVERT_TIMEOUT_MS = 20 * 1000;

/**
 * Registra la función del DM. Llamar al cargar el módulo (antes de "init").
 */
export function registerTransformSocket() {
  registerSocketHandler("revertForm", gmRevertForm);
}

/**
 * Teléfono: vuelve a la forma original.
 * @param {Actor} form  El actor transformado.
 * @returns {Promise<{ok: boolean, reason?: string, error?: string}>}
 */
export async function requestRevertForm(form) {
  console.log(`BHD Companion | Volver a la forma original: ${form?.name}`);
  if ( !form?.getFlag("dnd5e", "isPolymorphed") ) return { ok: false, reason: "NotTransformed" };
  if ( game.users.activeGM ) {
    const result = await callGM("revertForm", { actorUuid: form.uuid }, REVERT_TIMEOUT_MS);
    console.log("BHD Companion | Volver a la forma original: respuesta del DM", result);
    if ( result?.ok || (result?.reason !== "GMOutdated") ) return result;
  }
  try {
    await form.revertOriginalForm({ renderSheet: false });
    return { ok: true };
  } catch(err) {
    console.error("BHD Companion | Volver a la forma original: error", err);
    return { ok: false, reason: "Error", error: err?.message ?? String(err) };
  }
}

/**
 * DM: vuelve a la forma original la forma de un jugador.
 * @this {{socketdata: {userId: string}}}
 * @param {{actorUuid: string}} data
 */
async function gmRevertForm(data) {
  const user = game.users.get(this?.socketdata?.userId);
  const found = await fromUuid(data?.actorUuid);
  const form = (found instanceof Actor) ? found : found?.actor;
  const tag = `BHD Companion | [${user?.name ?? "?"}] Volver a la forma original`;
  if ( !form?.getFlag("dnd5e", "isPolymorphed") ) {
    console.warn(`${tag}: el actor no está transformado`, data);
    return { ok: false, reason: "NotTransformed" };
  }
  if ( !user || !form.testUserPermission(user, "OWNER") ) {
    console.warn(`${tag}: el jugador no es dueño de ${form.name}`);
    return { ok: false, reason: "NotOwner" };
  }
  try {
    console.log(`${tag}: ${form.name}`);
    await form.revertOriginalForm({ renderSheet: false });
    return { ok: true };
  } catch(err) {
    console.error(`${tag}: error`, err);
    return { ok: false, reason: "Error", error: err?.message ?? String(err) };
  }
}
