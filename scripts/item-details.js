/**
 * Detalle de un objeto al tocar su fila: lo mismo que enseña la hoja nativa de dnd5e.
 *
 * - Arriba, la ficha emergente (tooltip) de dnd5e (`item.system.richTooltip()`): imagen, tipo, cargas, bloque
 *   del hechizo (tiempo de lanzamiento / ritual, alcance, objetivo, componentes V/S/M y materiales, duración y
 *   concentración), descripción y propiedades. Es su plantilla, con sus datos.
 * - Debajo, cada actividad que se puede usar con sus etiquetas ya calculadas por dnd5e (activación, alcance,
 *   área u objetivo, duración, bonificador de ataque, CD, daño o curación, usos y recarga) y los usos del objeto.
 * Nada se calcula aquí.
 */

import { getUsableActivities } from "./quick-actions.js";

/**
 * HTML del detalle de un objeto.
 * @param {Item} item
 * @returns {Promise<string>}
 */
export async function renderItemDetails(item) {
  const escape = foundry.utils.escapeHTML;
  const parts = [];

  let tooltip = null;
  try {
    tooltip = await item.system.richTooltip?.();
  } catch(err) {
    console.warn("BHD Companion | No se pudo preparar la ficha de dnd5e del objeto", err);
  }
  if ( tooltip?.content ) parts.push(`<div class="bhd-native-tooltip">${tooltip.content}</div>`);
  else {
    // Sin ficha de dnd5e (tipos de objeto sin ella): la descripción, como la tarjeta del chat.
    const data = await item.getChatData({ secrets: item.isOwner });
    parts.push(`<section class="description">${data.description ?? ""}</section>`);
    if ( data.properties?.length ) parts.push(pills(data.properties));
  }

  // Usos del propio objeto (los de las actividades van con cada una).
  const identified = item.system.identified !== false;
  const uses = item.system.uses;
  if ( identified && item.system.hasLimitedUses && uses?.max ) {
    parts.push(`<p class="bhd-detail-uses">${escape(usesLabel(uses, item.labels))}</p>`);
  }

  // Actividades: lo que hace cada botón de la fila.
  const activities = identified || game.user.isGM ? getUsableActivities(item) : [];
  if ( activities.length ) {
    const rows = activities.map(activity => {
      const labels = activity.labels ?? {};
      const facts = [
        labels.activation,
        labels.range,
        labels.target,
        labels.duration,
        labels.toHit ? `${game.i18n.localize("BHD.Actions.Attack")} ${labels.toHit}` : null,
        labels.save,
        ...(labels.damage ?? []).map(d => d.label),
        activity.uses?.max ? usesLabel(activity.uses, labels) : null
      ].filter(_ => _);
      return `
        <li class="bhd-detail-activity">
          <img src="${escape(activity.img ?? item.img)}" alt="">
          <span class="bhd-detail-activity-text">
            <strong>${escape(activity.name)}</strong>
            ${facts.map(f => `<span class="bhd-detail-fact">${escape(String(f))}</span>`).join("")}
          </span>
        </li>`;
    });
    parts.push(`
      <h4 class="bhd-detail-heading">${escape(game.i18n.localize("BHD.Actions.Activities"))}</h4>
      <ul class="bhd-detail-activities">${rows.join("")}</ul>`);
  }
  else if ( identified ) {
    parts.push(`<p class="bhd-detail-passive">${escape(game.i18n.localize("BHD.Actions.PassiveHint"))}</p>`);
  }

  return parts.join("");
}

/**
 * "2/3 · Desc. largo" o "1/1 · Recarga [5-6]" (etiquetas de dnd5e).
 * @param {{value: number, max: number}} uses
 * @param {object} labels  Etiquetas del objeto o la actividad (`recovery`, `recharge`).
 * @returns {string}
 */
function usesLabel(uses, labels={}) {
  const recovery = labels.recharge || labels.recovery;
  return [
    game.i18n.format("BHD.Actions.UsesOf", { value: uses.value ?? 0, max: uses.max }),
    recovery
  ].filter(_ => _).join(" · ");
}

/**
 * Lista de propiedades (como las "píldoras" de dnd5e).
 * @param {string[]} properties
 * @returns {string}
 */
function pills(properties) {
  const escape = foundry.utils.escapeHTML;
  return `<ul class="pills">${properties.map(p => `<li class="pill"><span class="label">${escape(String(p))}</span></li>`).join("")}</ul>`;
}
