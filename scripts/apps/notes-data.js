import { MODULE_ID } from "../constants.js";

/**
 * Prepara la pestaña Notas: notas personales del jugador (guardadas en el personaje)
 * y la biografía y personalidad que vienen de la hoja de dnd5e.
 */

/** Clave del flag donde se guardan las notas personales: flags.bhd-companion.notes */
export const NOTES_FLAG = "notes";

/**
 * Notas personales guardadas en el personaje.
 * @param {Actor} actor
 * @returns {string}
 */
export function getSavedNotes(actor) {
  return actor?.getFlag(MODULE_ID, NOTES_FLAG) ?? "";
}

/**
 * Datos completos de la pestaña Notas.
 * @param {Actor} actor
 * @param {string|null} draft  Texto que el jugador está escribiendo y aún no se guardó.
 * @returns {Promise<object>}
 */
export async function prepareNotes(actor, draft) {
  const details = actor.system.details ?? {};
  const enrich = html => foundry.applications.ux.TextEditor.implementation.enrichHTML(html ?? "", {
    rollData: actor.getRollData(), relativeTo: actor, secrets: actor.isOwner
  });

  const personality = [
    ["trait", "BHD.Notes.Traits"],
    ["ideal", "BHD.Notes.Ideals"],
    ["bond", "BHD.Notes.Bonds"],
    ["flaw", "BHD.Notes.Flaws"]
  ].filter(([key]) => details[key]?.trim()).map(([key, label]) => ({
    label: game.i18n.localize(label),
    text: details[key]
  }));

  const biography = details.biography?.value?.trim() ? await enrich(details.biography.value) : "";

  return {
    text: draft ?? getSavedNotes(actor),
    personality,
    biography
  };
}
