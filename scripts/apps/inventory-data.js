/**
 * Prepara la pestaña Inventario: objetos agrupados por tipo, contenedores, monedas, peso y sintonización.
 * Solo lee valores ya calculados por dnd5e (peso total, carga, sintonización).
 */

/** Profundidad máxima de contenedores dentro de contenedores que se dibuja. */
const MAX_CONTAINER_DEPTH = 5;

/**
 * Datos completos de la pestaña Inventario.
 * @param {Actor} actor
 * @param {Set<string>} openContainers  Contenedores que el jugador dejó abiertos.
 * @returns {object}
 */
export function prepareInventory(actor, openContainers) {
  const byName = (a, b) => a.name.localeCompare(b.name, game.i18n.lang);

  // Secciones por tipo de objeto, en el mismo orden que la hoja de dnd5e (armas, equipo, consumibles...).
  const sectionConfigs = Object.entries(CONFIG.Item.dataModels)
    .filter(([type, model]) => ("inventorySection" in model) && (type !== "container"))
    .map(([type, model]) => ({ type, ...model.inventorySection }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const topLevel = actor.items.filter(item => !isInsideContainer(item, actor)).sort(byName);
  const sections = sectionConfigs.map(config => ({
    id: config.id,
    label: game.i18n.localize(config.label),
    items: topLevel.filter(item => item.type === config.type).map(item => prepareItemRow(item))
  })).filter(section => section.items.length);

  const containers = topLevel.filter(item => item.type === "container")
    .map(container => prepareContainer(container, actor, openContainers, 0));

  return {
    sections,
    containers,
    currency: prepareCurrency(actor),
    encumbrance: prepareEncumbrance(actor),
    attunement: prepareAttunement(actor),
    isEmpty: !sections.length && !containers.length
  };
}

/* -------------------------------------------- */

/**
 * ¿El objeto está guardado dentro de un contenedor de este mismo personaje?
 * @param {Item} item
 * @param {Actor} actor
 * @returns {boolean}
 */
function isInsideContainer(item, actor) {
  const containerId = item.system.container;
  return !!containerId && actor.items.has(containerId);
}

/**
 * Un contenedor (mochila, bolsa...) con lo que lleva dentro, incluidos otros contenedores.
 * @param {Item} container
 * @param {Actor} actor
 * @param {Set<string>} openContainers
 * @param {number} depth
 * @returns {object}
 */
function prepareContainer(container, actor, openContainers, depth) {
  const byName = (a, b) => a.name.localeCompare(b.name, game.i18n.lang);
  const contents = actor.items.filter(item => item.system.container === container.id).sort(byName);
  const canNest = depth < MAX_CONTAINER_DEPTH;
  return {
    ...prepareItemRow(container),
    open: openContainers.has(container.id),
    count: contents.length,
    items: contents.filter(item => !canNest || (item.type !== "container")).map(item => prepareItemRow(item)),
    containers: canNest ? contents.filter(item => item.type === "container")
      .map(item => prepareContainer(item, actor, openContainers, depth + 1)) : []
  };
}

/**
 * Datos de una fila del inventario.
 * @param {Item} item
 * @returns {object}
 */
function prepareItemRow(item) {
  const system = item.system;
  const canAttune = !!system.canAttune;
  const details = [];
  const weight = formatItemWeight(item);
  if ( weight ) details.push(weight);
  if ( canAttune && !system.attuned && (system.attunement === "required") ) {
    details.push(game.i18n.localize("BHD.Inventory.AttunementRequired"));
  }
  const uses = system.uses;
  return {
    id: item.id,
    name: item.name,
    img: item.img,
    quantity: system.quantity ?? 1,
    hasQuantity: "quantity" in system,
    subtitle: details.join(" · "),
    canEquip: "equipped" in system,
    equipped: !!system.equipped,
    canAttune,
    attuned: !!system.attuned,
    uses: uses?.max ? { value: uses.value ?? 0, max: uses.max, empty: !uses.value } : null
  };
}

/**
 * Peso total de la pila ("4,5 lb"), o "" si no pesa nada.
 * @param {Item} item
 * @returns {string}
 */
function formatItemWeight(item) {
  const total = item.system.totalWeight;
  const units = item.system.weight?.units;
  // En contenedores de un compendio el peso llega como promesa; en un personaje es un número.
  if ( !Number.isFinite(total) || (total <= 0) || !units ) return "";
  return dnd5e.utils.formatWeight(total.toNearest(0.01), units);
}

/* -------------------------------------------- */

/**
 * Monedas del personaje (platino, oro, electro, plata, cobre).
 * @param {Actor} actor
 * @returns {object[]}
 */
function prepareCurrency(actor) {
  const currency = actor.system.currency ?? {};
  return Object.entries(CONFIG.DND5E.currencies).map(([key, config]) => ({
    key,
    label: game.i18n.localize(config.label),
    abbr: game.i18n.localize(config.abbreviation),
    icon: config.icon,
    value: currency[key] ?? 0
  }));
}

/**
 * Peso que lleva el personaje y su capacidad de carga (ya calculados por dnd5e).
 * @param {Actor} actor
 * @returns {object|null}
 */
function prepareEncumbrance(actor) {
  const encumbrance = actor.system.attributes?.encumbrance;
  if ( !encumbrance ) return null;
  const metric = game.settings.get("dnd5e", "metricWeightUnits");
  const baseUnits = CONFIG.DND5E.encumbrance.baseUnits[actor.type] ?? CONFIG.DND5E.encumbrance.baseUnits.default;
  const units = baseUnits[metric ? "metric" : "imperial"];
  const value = encumbrance.value ?? 0;
  const max = encumbrance.max;
  const thresholds = encumbrance.thresholds ?? {};

  // Con las reglas de carga activadas, se avisa si el personaje va cargado.
  const rule = game.settings.get("dnd5e", "encumbrance");
  let status = null;
  if ( Number.isFinite(max) && (value > max) ) status = "over";
  else if ( (rule === "variant") && (value > thresholds.heavilyEncumbered) ) status = "heavy";
  else if ( (rule === "variant") && (value > thresholds.encumbered) ) status = "encumbered";

  return {
    value: dnd5e.utils.formatWeight(value, units),
    max: Number.isFinite(max) ? dnd5e.utils.formatWeight(max, units) : null,
    pct: Math.round(encumbrance.pct ?? 0),
    stops: (rule === "variant") ? encumbrance.stops : null,
    status
  };
}

/**
 * Objetos sintonizados / máximo.
 * @param {Actor} actor
 * @returns {{value: number, max: number, full: boolean}|null}
 */
function prepareAttunement(actor) {
  const attunement = actor.system.attributes?.attunement;
  if ( !attunement ) return null;
  const value = attunement.value ?? 0;
  const max = attunement.max ?? 0;
  return { value, max, full: value >= max };
}
