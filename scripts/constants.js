export const MODULE_ID = "bhd-companion";

/** Ruta base de las plantillas Handlebars del módulo. */
export const TEMPLATE_PATH = `modules/${MODULE_ID}/templates`;

/**
 * ¿Midi QOL está activo en el mundo? Con Midi, los ataques, hechizos y rasgos del teléfono los ejecuta
 * el cliente del DM (ver midi-remote.js); sin Midi, el teléfono usa el flujo nativo de dnd5e.
 * @returns {boolean}
 */
export function isMidiActive() {
  return !!game.modules.get("midi-qol")?.active;
}
