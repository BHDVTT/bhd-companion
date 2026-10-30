/**
 * Prepara la pestaña Hechizos: todos los hechizos del personaje como en la hoja de dnd5e (trucos, niveles, pacto,
 * innatos, a voluntad, rituales, multiclase), con sus espacios, sus etiquetas y los mismos botones que Acciones.
 * Solo lee lo que calcula dnd5e (`item.labels`, `system.prepared`, `spellcasting.preparation` de cada clase).
 */

import { prepareRow, prepareSpellbook } from "./actions-data.js";

/** Tiempos de activación con filtro propio en la pestaña. */
export const SPELL_ACTIVATIONS = ["action", "bonus", "reaction"];

/**
 * ¿El personaje tiene algún hechizo? (Sin hechizos, la pestaña no se ve.)
 * @param {Actor|null} actor
 * @returns {boolean}
 */
export function hasSpells(actor) {
  return !!actor?.items.some(item => item.type === "spell");
}

/**
 * ¿Se puede marcar o desmarcar este hechizo como preparado? Como la hoja de dnd5e: su método prepara
 * (`canPrepare`), no es un truco y no está "siempre preparado".
 * @param {Item} item
 * @returns {boolean}
 */
export function canTogglePrepared(item) {
  const system = item.system;
  return !!system.canPrepare && (system.level > 0)
    && (system.prepared !== CONFIG.DND5E.spellPreparationStates.always.value);
}

/**
 * Límite de preparados de la clase del hechizo, tal como lo cuenta dnd5e (`spellcasting.preparation`).
 * @param {Item} item
 * @returns {{name: string, value: number, max: number}|null}  null si la clase no tiene límite (o no se sabe).
 */
export function getPreparationLimit(item) {
  const sourceClass = item.system.classIdentifier ? item.actor?.spellcastingClasses?.[item.system.classIdentifier] : null;
  const preparation = sourceClass?.system.spellcasting?.preparation;
  if ( !preparation?.max ) return null;
  return { name: sourceClass.name, value: preparation.value ?? 0, max: preparation.max };
}

/**
 * Datos de la pestaña.
 * @param {Actor} actor
 * @param {QuickActionState} state
 * @param {object} filters  Filtros elegidos (nivel, tiempo, concentración, ritual, preparados, búsqueda).
 * @returns {object}
 */
export function prepareSpellsTab(actor, state, filters) {
  const spells = actor.items.filter(item => item.type === "spell");
  const sections = prepareSpellbook(actor, spells, state, { all: true, row: prepareSpellRow });
  const attributes = actor.system.attributes.spell ?? {};

  // Cuántos preparados lleva cada clase que prepara (multiclase: una línea por clase).
  const preparation = Object.values(actor.spellcastingClasses ?? {}).map(cls => {
    const p = cls.system.spellcasting?.preparation;
    return p?.max ? { name: cls.name, value: p.value ?? 0, max: p.max, full: (p.value ?? 0) >= p.max } : null;
  }).filter(_ => _);

  const levels = [...new Set(spells.map(s => s.system.level ?? 0))].sort((a, b) => a - b);
  const localize = key => game.i18n.localize(key);
  return {
    sections,
    spellcasting: {
      dc: attributes.dc ?? null,
      attack: Number.isFinite(attributes.attack) ? dnd5e.utils.formatNumber(attributes.attack, { signDisplay: "always" }) : null
    },
    preparation,
    filters: {
      search: filters.search,
      levels: [
        { value: "all", label: localize("BHD.Spells.AllLevels"), selected: filters.level === "all" },
        ...levels.map(level => ({
          value: String(level),
          label: CONFIG.DND5E.spellLevels[level] ?? String(level),
          selected: filters.level === String(level)
        }))
      ],
      toggles: [
        { id: "concentration", icon: "fa-solid fa-c", label: localize("BHD.Spells.Concentration"), on: filters.concentration },
        { id: "ritual", icon: "fa-solid fa-r", label: localize("BHD.Spells.Ritual"), on: filters.ritual },
        ...(spells.some(s => s.system.canPrepare) ? [
          { id: "prepared", icon: "fa-solid fa-book-open", label: localize("BHD.Spells.Prepared"), on: filters.prepared }
        ] : [])
      ],
      activations: ["all", ...SPELL_ACTIVATIONS].map(id => ({
        id,
        label: localize(`BHD.Actions.Filter${id.capitalize()}`),
        on: filters.activation === id
      }))
    }
  };
}

/**
 * Fila de un hechizo: la de Acciones (botones, nivel del espacio) más lo que enseña la hoja: escuela,
 * tiempo de lanzamiento, alcance, duración, componentes, concentración, ritual y preparado.
 * @param {Item} item
 * @param {object} options  Las de `prepareRow`.
 * @returns {object}
 */
function prepareSpellRow(item, options) {
  const row = prepareRow(item, options);
  const system = item.system;
  const labels = item.labels ?? {};
  const states = CONFIG.DND5E.spellPreparationStates;
  const concentration = !!system.properties?.has("concentration");
  const ritual = !!system.properties?.has("ritual");
  const always = system.prepared === states.always.value;
  // Como el filtro "Preparados" de la hoja de dnd5e: método que prepara y marcado (o siempre preparado).
  const prepared = !!system.canPrepare && !!system.prepared;
  const flags = [concentration ? "concentration" : "", ritual ? "ritual" : "", prepared ? "prepared" : ""].filter(_ => _);

  // Concentración y ritual van como iconos: de las etiquetas cortas solo queda el nivel (en pacto, innatos...).
  row.tags = (options.showLevel && (system.level > 0)) ? [game.i18n.format("BHD.Actions.LevelShort", { level: system.level })] : [];
  row.subtitle = [labels.activation, labels.range, labels.duration].filter(_ => _).join(" · ");
  row.spell = {
    level: system.level ?? 0,
    // "Evocación · V, S, M" (escuela y componentes, las etiquetas de dnd5e)
    meta: [labels.school, labels.components?.vsm].filter(_ => _).join(" · "),
    concentration,
    ritual,
    flags: flags.join(" "),
    prepare: canTogglePrepared(item) ? { prepared: !!system.prepared }
      : (always ? { always: true, label: states.always.label } : null)
  };
  return row;
}
