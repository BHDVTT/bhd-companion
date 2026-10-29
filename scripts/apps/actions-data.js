/**
 * Prepara la pestaña Acciones: ataques, hechizos por nivel, rasgos y consumibles.
 * Solo lee valores ya calculados por dnd5e (etiquetas, usos, espacios de conjuro).
 */

/** Tipos de activación que tienen filtro propio en la pestaña. */
export const ACTION_FILTERS = ["action", "bonus", "reaction"];

/**
 * Datos completos de la pestaña Acciones.
 * @param {Actor} actor
 * @returns {object}
 */
export function prepareActions(actor) {
  const attacks = [];
  const spells = [];
  const features = [];
  const consumables = [];

  for ( const item of actor.items ) {
    switch ( item.type ) {
      case "weapon":
        if ( item.system.equipped && item.system.activities?.size ) attacks.push(item);
        break;
      case "spell":
        spells.push(item);
        break;
      case "feat":
        if ( item.system.activities?.size ) features.push(item);
        break;
      case "consumable":
        if ( (item.system.type?.value !== "ammo") && (item.system.quantity > 0) ) consumables.push(item);
        break;
    }
  }

  const byName = (a, b) => a.name.localeCompare(b.name, game.i18n.lang);
  const spellbook = prepareSpellbook(actor, spells);
  const spellAttributes = actor.system.attributes.spell ?? {};

  return {
    attacks: attacks.sort(byName).map(item => prepareRow(item)),
    spellbook,
    spellcasting: spellbook.length ? {
      dc: spellAttributes.dc ?? null,
      attack: Number.isFinite(spellAttributes.attack) ? signed(spellAttributes.attack) : null
    } : null,
    features: features.sort(byName).map(item => prepareRow(item)),
    consumables: consumables.sort(byName).map(item => prepareRow(item)),
    isEmpty: !attacks.length && !spellbook.length && !features.length && !consumables.length
  };
}

/* -------------------------------------------- */

/**
 * Hechizos agrupados por nivel (o por método: pacto, innatos...) con sus espacios de conjuro.
 * Sigue la misma lógica que la hoja de personaje de dnd5e para decidir la sección de cada hechizo:
 * los de pacto van todos a "Magia de pacto" (se lanzan al nivel del espacio de pacto), los demás
 * a la sección de su nivel. Qué hechizos se muestran lo decide `isSpellShown`.
 * @param {Actor} actor
 * @param {Item[]} spells
 * @returns {object[]}
 */
function prepareSpellbook(actor, spells) {
  const sections = {};

  const registerSection = (key, level, config) => {
    if ( key in sections ) return;
    level = config?.slots ? level : 1;
    const usesSlots = !!config?.slots && (level !== 0);
    const section = sections[key] = {
      key,
      label: config?.getLabel?.({ level }) ?? config?.label ?? game.i18n.localize("DND5E.CAST.SECTIONS.Spellbook"),
      order: level === 0 ? 0 : (config?.order ?? 1000),
      level: level ?? 0,
      slots: null,
      items: []
    };
    if ( !usesSlots ) return;
    const data = foundry.utils.getProperty(actor.system.spells, key) ?? {};
    const max = data.override ?? data.max ?? 0;
    const value = data.value ?? 0;
    section.slots = {
      value,
      max,
      pips: Array.fromRange(Math.max(max, value), 1).map(n => ({ filled: value >= n, temp: n > max }))
    };
  };

  // Secciones de los métodos de lanzamiento que tiene el personaje (aunque estén vacías, para ver los espacios).
  for ( const config of Object.values(CONFIG.DND5E.spellcasting) ) {
    const levels = config.getAvailableLevels?.(actor) ?? [];
    if ( !levels.length ) continue;
    if ( config.cantrips ) registerSection("spell0", 0, CONFIG.DND5E.spellcasting.spell);
    levels.forEach(l => registerSection(config.getSpellSlotKey(l), l, config));
  }

  for ( const spell of spells ) {
    const system = spell.system;
    if ( !isSpellShown(spell, actor) ) continue;
    let method = system.method;
    if ( !(method in CONFIG.DND5E.spellcasting) ) method = "innate";
    const config = CONFIG.DND5E.spellcasting[method];
    // Métodos de un solo nivel (pacto): todos los hechizos de nivel 1+ comparten sección.
    const level = (config?.isSingleLevel && (system.level !== 0)) ? null : (system.level || 0);
    let key = config?.getSpellSlotKey?.(level) ?? method;

    // Hechizos que vienen de un objeto (p. ej. una varita)
    if ( spell.getFlag("dnd5e", "cachedFor") ) {
      if ( !system.linkedActivity?.displayInSpellbook ) continue;
      key = "item";
      registerSection(key);
    }
    else registerSection(key, level, config);
    sections[key].items.push(spell);
  }

  const byLevelAndName = (a, b) => ((a.system.level ?? 0) - (b.system.level ?? 0))
    || a.name.localeCompare(b.name, game.i18n.lang);
  return Object.values(sections)
    .filter(section => section.items.length || section.slots?.max)
    .sort((a, b) => (a.order - b.order) || (a.level - b.level))
    .map(section => {
      // En secciones por nivel ("Nivel 2") el nivel ya se ve en el título; en las demás (pacto,
      // innatos, rituales...) cada hechizo muestra su nivel.
      const showLevel = !/^spell\d+$/.test(section.key);
      return { ...section, items: section.items.sort(byLevelAndName).map(item => prepareRow(item, { showLevel })) };
    });
}

/**
 * ¿Se muestra este hechizo en la pestaña Acciones?
 * - Trucos, siempre preparados, preparados, innatos, a voluntad y rituales: sí.
 * - Pacto (brujo): sí, todos los que conoce, aunque dnd5e los marque "sin preparar"
 *   (en dnd5e 5.x los hechizos de pacto suelen quedar con `prepared: 0`).
 * - Sin preparar de una clase que prepara hechizos (clérigo, mago, druida...): no, para no llenar
 *   la lista con todo el libro de conjuros. Si la clase no prepara (o no se sabe y ninguna clase del
 *   personaje con ese método prepara), se muestra.
 * @param {Item} spell
 * @param {Actor} actor
 * @returns {boolean}
 */
function isSpellShown(spell, actor) {
  const system = spell.system;
  if ( !(system.level > 0) || system.prepared || !system.canPrepare ) return true;
  const config = CONFIG.DND5E.spellcasting[system.method];
  if ( config?.isSingleLevel ) return true;

  const classes = actor.spellcastingClasses ?? {};
  const prepares = cls => (cls?.system.spellcasting?.preparation?.max ?? 0) > 0;
  const sourceClass = system.classIdentifier ? classes[system.classIdentifier] : null;
  if ( sourceClass ) return !prepares(sourceClass);
  return !Object.values(classes).some(cls => (cls.system.spellcasting?.type === system.method) && prepares(cls));
}

/* -------------------------------------------- */

/**
 * Datos de una fila: nombre, icono, resumen, valor de tirada y usos restantes.
 * @param {Item} item
 * @param {object} [options]
 * @param {boolean} [options.showLevel]  Mostrar el nivel del hechizo ("Nv. 1") junto al nombre.
 * @returns {object}
 */
function prepareRow(item, { showLevel=false }={}) {
  const system = item.system;
  const labels = item.labels ?? {};
  const activities = system.activities?.filter(a => a.canUse) ?? [];

  // Tipos de activación (acción, adicional, reacción...) para los filtros.
  const activation = new Set();
  if ( system.activation?.type ) activation.add(system.activation.type);
  for ( const activity of activities ) {
    if ( activity.activation?.type ) activation.add(activity.activation.type);
  }

  // Resumen: tiempo de lanzamiento / activación, alcance y daño.
  const damage = (labels.damages ?? []).map(d => d.label ?? d.formula).filter(_ => _).join(" + ");
  const subtitle = [labels.activation, labels.range, damage].filter(_ => _).join(" · ");

  // Etiquetas cortas: nivel, concentración y ritual (hechizos), cantidad (consumibles).
  const tags = [];
  if ( item.type === "spell" ) {
    if ( showLevel && (system.level > 0) ) tags.push(game.i18n.format("BHD.Actions.LevelShort", { level: system.level }));
    if ( system.properties?.has("concentration") ) tags.push(game.i18n.localize("BHD.Actions.ConcentrationAbbr"));
    if ( system.properties?.has("ritual") ) tags.push(game.i18n.localize("BHD.Actions.RitualAbbr"));
  }
  if ( (item.type === "consumable") && (system.quantity > 1) ) tags.push(`×${system.quantity}`);

  return {
    id: item.id,
    name: item.name,
    img: item.img,
    subtitle,
    tags,
    activation: [...activation].join(" "),
    search: normalizeSearch(item.name),
    roll: getRollLabel(item, activities),
    uses: getUses(item, activities)
  };
}

/**
 * Lo que se muestra a la derecha: bonificador de ataque o CD de salvación.
 * @param {Item} item
 * @param {Activity[]} activities
 * @returns {string|null}
 */
function getRollLabel(item, activities) {
  if ( item.labels?.toHit ) return item.labels.toHit;
  const save = activities.find(a => a.type === "save");
  const dc = save?.save?.dc?.value;
  if ( dc ) return game.i18n.format("BHD.Actions.DC", { dc });
  return null;
}

/**
 * Usos limitados del objeto o, si no tiene, de su primera actividad con usos.
 * @param {Item} item
 * @param {Activity[]} activities
 * @returns {{value: number, max: number, empty: boolean}|null}
 */
function getUses(item, activities) {
  let uses = item.system.hasLimitedUses ? item.system.uses : null;
  if ( !uses ) uses = activities.find(a => a.uses?.max)?.uses;
  if ( !uses?.max ) return null;
  const value = uses.value ?? 0;
  return { value, max: uses.max, empty: value <= 0 };
}

/* -------------------------------------------- */

/**
 * Texto en minúsculas y sin acentos, para buscar ("bola de fuego" encuentra "Bola de Fuego").
 * @param {string} text
 * @returns {string}
 */
export function normalizeSearch(text) {
  return (text ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

/**
 * Número con signo: +3, -1, +0.
 * @param {number} value
 * @returns {string}
 */
function signed(value) {
  return dnd5e.utils.formatNumber(value ?? 0, { signDisplay: "always" });
}
