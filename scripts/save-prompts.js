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
 * Salvaciones que este mensaje pide al personaje. Con Midi QOL, las de los hechizos y la concentración las
 * pide Midi directamente al teléfono (midi-prompts.js): del chat solo se leen las peticiones del DM.
 * @param {ChatMessage} message
 * @param {Actor} actor
 * @param {object} [options]
 * @param {boolean} [options.midi]  ¿Midi QOL está activo?
 * @returns {SavePrompt[]}
 */
export function findSavePrompts(message, actor, { midi=false }={}) {
  if ( !actor || !message.visible ) return [];
  if ( ["prompt", "usage"].includes(message.type) && message.system?.buttons ) return findDataPrompts(message, actor, midi);
  if ( !message.content?.includes("data-action") ) return [];
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
  if ( !midi && (message.speaker?.actor === actor.id) ) {
    root.querySelectorAll('[data-action="concentration"]').forEach((button, i) => {
      add("concentration", button, `c${i}`, game.i18n.localize("BHD.Save.ConcentrationSource"));
    });
  }

  // Tarjeta de una actividad de salvación con el personaje entre sus objetivos.
  const flags = message.flags?.dnd5e ?? {};
  if ( !midi && (flags.activity?.type === "save") && (message.speaker?.actor !== actor.id) ) {
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
 * dnd5e 6: las tarjetas ya no guardan su HTML; los botones están en los datos del mensaje.
 * - Tipo "prompt": concentración al recibir daño (`challengeConcentration`) y petición de tirada del DM.
 * - Tipo "usage": tarjeta de una actividad de salvación, con los objetivos en `system.targets`.
 * @param {ChatMessage} message
 * @param {Actor} actor
 * @param {boolean} midi
 * @returns {SavePrompt[]}
 */
function findDataPrompts(message, actor, midi) {
  const showDC = message.shouldDisplayChallenge ?? true;
  const prompts = [];
  const add = (type, { ability, dc }, index, source) => prompts.push({
    id: `${message.id}.${index}`,
    messageId: message.id,
    type,
    ability: (ability in CONFIG.DND5E.abilities) ? ability : null,
    dc: Number.isFinite(parseInt(dc)) ? parseInt(dc) : null,
    showDC,
    source
  });
  const system = message.system;
  const ownMessage = message.speaker?.actor === actor.id;

  if ( message.type === "prompt" ) {
    system.buttons.forEach((button, i) => {
      if ( button.type === "concentration" ) {
        if ( !midi && ownMessage ) add("concentration", button, `c${i}`, game.i18n.localize("BHD.Save.ConcentrationSource"));
        else if ( message.author?.isGM && actor.concentration?.effects.size ) {
          add("concentration", button, `rc${i}`, message.author.name);
        }
      }
      else if ( (button.type === "save") && message.author?.isGM && system.broadcast ) {
        add("save", button, `r${i}`, message.author.name);
      }
    });
    return prompts;
  }

  // Tarjeta de salvación con el personaje entre sus objetivos.
  if ( midi || ownMessage ) return prompts;
  const targeted = Array.from(system.targets ?? []).some(t => (t.actor === actor.uuid) || (t.uuid === actor.uuid));
  if ( !targeted ) return prompts;
  const source = message.speaker?.alias || message.author?.name || "";
  system.buttons.forEach((button, i) => {
    if ( button.action === "rollSave" ) add("save", button.dataset ?? {}, `s${i}`, source);
  });
  return prompts;
}

/**
 * Texto del botón: "Salvación de Destreza (CD 15)" (o prueba, habilidad o herramienta si las pide Midi).
 * @param {SavePrompt} prompt
 * @param {Actor} actor
 * @returns {string}
 */
export function getSavePromptLabel(prompt, actor) {
  let ability = prompt.ability;
  if ( (prompt.type === "concentration") && !ability ) {
    ability = actor?.system.attributes?.concentration?.ability || CONFIG.DND5E.defaultAbilities.concentration;
  }
  const abilityLabel = CONFIG.DND5E.abilities[ability]?.label ?? "";
  const keys = {
    concentration: "BHD.Save.ConcentrationButton",
    check: "BHD.Save.CheckButton",
    skill: "BHD.Save.SkillButton",
    tool: "BHD.Save.ToolButton"
  };
  const tool = prompt.tool ? (dnd5e.documents?.Trait?.keyLabel?.(prompt.tool, { trait: "tool" }) ?? prompt.tool) : "";
  const label = game.i18n.format(keys[prompt.type] ?? "BHD.Save.Button", {
    ability: abilityLabel,
    skill: CONFIG.DND5E.skills[prompt.skill]?.label ?? prompt.skill ?? "",
    tool
  });
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
