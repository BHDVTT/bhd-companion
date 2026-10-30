/**
 * Salvaciones pendientes para el personaje del jugador, leídas de los mensajes nuevos del chat:
 * - Tarjeta de un hechizo o rasgo con salvación (p. ej. del DM) que tiene al personaje como objetivo.
 * - Salvación de concentración que dnd5e pide al recibir daño (`challengeConcentration`).
 * - Petición de tirada de salvación del DM ("Request roll" de dnd5e), para todos.
 * El teléfono muestra un aviso con un botón para tirarla con las funciones de dnd5e.
 */

/**
 * @typedef {object} SavePrompt
 * @property {string} id          Mensaje y botón (para no repetir el aviso).
 * @property {string} messageId
 * @property {"save"|"concentration"} type
 * @property {string|null} ability
 * @property {number|null} dc
 * @property {boolean} showDC     ¿El jugador puede ver la CD? (ajuste de dnd5e "challengeVisibility").
 * @property {string} source      Qué la pide (nombre del hechizo o del atacante).
 */

/**
 * Salvaciones que este mensaje pide al personaje.
 * @param {ChatMessage} message
 * @param {Actor} actor
 * @returns {SavePrompt[]}
 */
export function findSavePrompts(message, actor) {
  if ( !actor || !message.visible || !message.content?.includes("data-action") ) return [];
  const template = document.createElement("template");
  template.innerHTML = message.content;
  const root = template.content;
  const showDC = message.shouldDisplayChallenge ?? true;
  const prompts = [];
  const add = (type, button, index, source) => {
    const dc = parseInt(button.dataset.dc);
    prompts.push({
      id: `${message.id}.${index}`,
      messageId: message.id,
      type,
      ability: (button.dataset.ability in CONFIG.DND5E.abilities) ? button.dataset.ability : null,
      dc: Number.isFinite(dc) ? dc : null,
      showDC,
      source
    });
  };

  // Concentración: el mensaje habla como el personaje que se concentra.
  if ( message.speaker?.actor === actor.id ) {
    root.querySelectorAll('[data-action="concentration"]').forEach((button, i) => {
      add("concentration", button, `c${i}`, game.i18n.localize("BHD.Save.ConcentrationSource"));
    });
  }

  // Tarjeta de una actividad de salvación con el personaje entre sus objetivos.
  const flags = message.flags?.dnd5e ?? {};
  if ( (flags.activity?.type === "save") && (message.speaker?.actor !== actor.id) ) {
    const targeted = (flags.targets ?? []).some(t => t.uuid === actor.uuid);
    if ( targeted ) {
      const source = message.speaker?.alias || message.author?.name || "";
      root.querySelectorAll('[data-action="rollSave"]').forEach((button, i) => add("save", button, `s${i}`, source));
    }
  }

  // Petición de tirada del DM para todos.
  if ( message.author?.isGM ) {
    root.querySelectorAll('[data-action="rollRequest"][data-type="save"]').forEach((button, i) => {
      add("save", button, `r${i}`, message.author.name);
    });
    root.querySelectorAll('[data-action="rollRequest"][data-type="concentration"]').forEach((button, i) => {
      if ( actor.concentration?.effects.size ) add("concentration", button, `rc${i}`, message.author.name);
    });
  }
  return prompts;
}

/**
 * Texto del botón: "Salvación de Destreza (CD 15)".
 * @param {SavePrompt} prompt
 * @param {Actor} actor
 * @returns {string}
 */
export function getSavePromptLabel(prompt, actor) {
  let ability = prompt.ability;
  if ( (prompt.type === "concentration") && !ability ) {
    ability = actor.system.attributes?.concentration?.ability || CONFIG.DND5E.defaultAbilities.concentration;
  }
  const abilityLabel = CONFIG.DND5E.abilities[ability]?.label ?? "";
  const key = (prompt.type === "concentration") ? "BHD.Save.ConcentrationButton" : "BHD.Save.Button";
  const label = game.i18n.format(key, { ability: abilityLabel });
  return (prompt.showDC && prompt.dc) ? `${label} (${game.i18n.format("BHD.Actions.DC", { dc: prompt.dc })})` : label;
}

/**
 * Tira la salvación con dnd5e, sin ventana.
 * @param {SavePrompt} prompt
 * @param {Actor} actor
 * @param {Event} [event]
 * @returns {Promise<Roll[]|null>}
 */
export async function rollSavePrompt(prompt, actor, event) {
  const config = { event };
  if ( prompt.ability ) config.ability = prompt.ability;
  if ( prompt.dc ) config.target = prompt.dc;
  if ( prompt.type === "concentration" ) return actor.rollConcentration(config, { configure: false });
  if ( !config.ability ) return null;
  return actor.rollSavingThrow(config, { configure: false });
}
