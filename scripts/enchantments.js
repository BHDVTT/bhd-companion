/**
 * Encantar objetos desde el teléfono (actividades "Encantar" de dnd5e: arma de pacto, Arma mágica...).
 *
 * En el chat, la tarjeta de una actividad de encantar trae una zona (`<enchantment-application>`) donde se
 * arrastra el objeto que se quiere encantar, con la lista de lo ya encantado y un botón para quitarlo. En el
 * teléfono no se puede arrastrar: la vista muestra esa misma información como lista. Todo sale de dnd5e:
 * qué tipos de objeto se pueden encantar (`enchantableTypes`), si un objeto cumple las restricciones
 * (`canEnchant`), qué encantamiento eligió la tarjeta (`use.enchantmentProfile`), lo ya encantado
 * (`dnd5e.registry.enchantments.applied`) y cómo se aplica (`applyEnchantment`), igual que al soltar el objeto.
 */

/**
 * Datos de la lista de encantar de una tarjeta del chat, o null si la tarjeta no encanta nada.
 * @param {ChatMessage} message
 * @returns {object|null}
 */
export function prepareEnchantPicker(message) {
  const profile = message?.getFlag("dnd5e", "use.enchantmentProfile");
  const activity = message?.getAssociatedActivity?.();
  if ( !profile || (activity?.type !== "enchant") ) return null;
  const actor = activity.actor;

  // Cuántos objetos como mucho (al nivel lanzado), como el contador de la tarjeta.
  let scaled = activity;
  const scaling = message.system?.scaling;
  if ( scaling ) scaled = activity.item.clone({ "flags.dnd5e.scaling": scaling }).system.activities.get(activity.id) ?? activity;
  const max = Number(scaled.target?.affects?.count) || null;

  const effects = dnd5e.registry.enchantments.applied(activity.uuid);
  const applied = effects.map(effect => ({
    uuid: effect.uuid,
    name: effect.parent?.name ?? effect.name,
    img: effect.parent?.img ?? effect.img,
    removable: !!effect.parent?.isOwner
  }));
  const enchanted = new Set(effects.map(e => e.parent?.id));

  const types = activity.enchantableTypes;
  const candidates = actor.items
    .filter(item => types.has(item.type) && !enchanted.has(item.id) && (activity.canEnchant(item) === true))
    .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang))
    .map(item => ({ id: item.id, name: item.name, img: item.img }));

  // Si el encantamiento depende de la concentración y ya terminó, dnd5e no deja aplicarlo.
  const concentrationId = message.system?.concentration;
  const concentrationEnded = !!concentrationId && !actor.effects.get(concentrationId);

  return {
    messageId: message.id,
    title: activity.item.name,
    img: activity.item.img,
    max,
    full: !!max && (applied.length >= max),
    applied,
    candidates,
    concentrationEnded
  };
}

/**
 * Encanta un objeto del personaje con el encantamiento de la tarjeta (lo mismo que soltarlo en ella).
 * @param {ChatMessage} message
 * @param {string} itemId
 * @returns {Promise<ActiveEffect|null>}
 */
export async function applyEnchantment(message, itemId) {
  const activity = message.getAssociatedActivity();
  const item = activity?.actor?.items.get(itemId);
  if ( !item ) return null;
  const concentrationId = message.system?.concentration;
  const concentration = concentrationId ? activity.actor.effects.get(concentrationId) : undefined;
  if ( concentrationId && !concentration ) {
    ui.notifications.error("DND5E.ENCHANT.Warning.ConcentrationEnded", { console: false, localize: true });
    return null;
  }
  return activity.applyEnchantment(message.getFlag("dnd5e", "use.enchantmentProfile"), item, {
    chatMessage: message, concentration
  });
}

/**
 * Quita un encantamiento (el botón "deshacer" de la tarjeta).
 * @param {ChatMessage} message
 * @param {string} uuid  Efecto del encantamiento.
 */
export async function removeEnchantment(message, uuid) {
  const enchantment = await fromUuid(uuid);
  await enchantment?.delete({ chatMessageOrigin: message?.id });
}
