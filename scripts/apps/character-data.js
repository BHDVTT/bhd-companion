/**
 * Prepara los datos de un personaje de dnd5e para las plantillas de la vista móvil.
 * Solo lee valores ya calculados por el sistema (nunca recalcula reglas).
 */

/**
 * Personajes que este usuario puede usar: los suyos (dueño) y el asignado por el GM.
 * @returns {Actor[]}
 */
export function getCharacterChoices() {
  const choices = game.actors.filter(a => (a.type === "character") && a.isOwner);
  const assigned = game.user.character;
  if ( assigned && !choices.includes(assigned) ) choices.push(assigned);
  return choices.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
}

/**
 * Personaje que muestra la vista: el asignado al usuario o, si no hay, el primero que posee.
 * @returns {Actor|null}
 */
export function getActiveCharacter() {
  return game.user.character ?? getCharacterChoices()[0] ?? null;
}

/* -------------------------------------------- */

/**
 * Datos completos de la hoja de personaje.
 * @param {Actor} actor
 * @returns {object}
 */
export function prepareCharacterSheet(actor) {
  const system = actor.system;
  const attributes = system.attributes;
  return {
    name: actor.name,
    img: actor.img,
    classLabel: getClassLabel(actor),
    level: system.details?.level ?? 0,
    inspiration: !!attributes.inspiration,
    hp: prepareHitPoints(attributes.hp),
    ac: attributes.ac?.value ?? 10,
    initiative: signed(attributes.init?.total ?? 0),
    prof: signed(attributes.prof ?? 0),
    speed: prepareSpeed(attributes.movement),
    conditions: prepareConditions(actor),
    abilities: prepareAbilities(system.abilities),
    skills: prepareSkills(system.skills),
    rest: prepareRest(actor)
  };
}

/* -------------------------------------------- */

/**
 * Datos de la tarjeta de descansos: dados de golpe y si el jugador puede descansar por su cuenta.
 * @param {Actor} actor
 */
function prepareRest(actor) {
  const hd = actor.system.attributes?.hd;
  const sizes = hd?.sizes ? Array.from(hd.sizes).sort((a, b) => b - a).map(size => `d${size}`).join(" / ") : "";
  return {
    // dnd5e tiene un ajuste del mundo para que solo el DM pueda iniciar descansos.
    allowed: game.user.isGM || game.settings.get("dnd5e", "allowRests"),
    hitDice: hd?.max ? { value: hd.value ?? 0, max: hd.max, sizes } : null
  };
}

/* -------------------------------------------- */

/**
 * "Guerrero 3 · Mago 2". Incluye la subclase si solo hay una clase.
 * @param {Actor} actor
 * @returns {string}
 */
function getClassLabel(actor) {
  const classes = Object.values(actor.classes ?? {}).sort((a, b) => b.system.levels - a.system.levels);
  if ( classes.length === 1 ) {
    const [cls] = classes;
    const subclass = cls.subclass ? ` (${cls.subclass.name})` : "";
    return `${cls.name} ${cls.system.levels}${subclass}`;
  }
  return classes.map(cls => `${cls.name} ${cls.system.levels}`).join(" · ");
}

/**
 * Puntos de golpe con porcentajes para dibujar la barra.
 * @param {object} hp  system.attributes.hp
 */
function prepareHitPoints(hp) {
  const value = hp?.value ?? 0;
  const max = Math.max(hp?.max ?? 0, 0);
  const temp = hp?.temp ?? 0;
  const pct = max ? Math.clamp(value / max, 0, 1) : 0;
  let level = "high";
  if ( pct <= 0.25 ) level = "low";
  else if ( pct <= 0.5 ) level = "mid";
  return { value, max, temp, pct: Math.round(pct * 100), level };
}

/**
 * Velocidad principal (caminar) y otros tipos de movimiento.
 * @param {object} movement  system.attributes.movement
 */
function prepareSpeed(movement = {}) {
  const format = value => dnd5e.utils.formatLength(value, movement.units);
  const others = Object.entries(CONFIG.DND5E.movementTypes)
    .filter(([key, config]) => (key !== "walk") && !config.hidden && movement[key])
    .map(([key, config]) => `${game.i18n.localize(config.label)} ${format(movement[key])}`);
  if ( movement.special ) others.push(movement.special);
  return { walk: format(movement.walk ?? 0), others: others.join(" · ") };
}

/**
 * Estados activos (condiciones de Foundry/dnd5e) del personaje.
 * @param {Actor} actor
 */
function prepareConditions(actor) {
  const conditions = [];
  for ( const status of CONFIG.statusEffects ) {
    if ( !actor.statuses.has(status.id) ) continue;
    let label = game.i18n.localize(status.name);
    if ( status.id === "exhaustion" ) label += ` ${actor.system.attributes.exhaustion ?? ""}`;
    conditions.push({ id: status.id, label, img: status.img });
  }
  return conditions;
}

/**
 * Las seis características con su modificador y su salvación.
 * @param {object} abilities  system.abilities
 */
function prepareAbilities(abilities = {}) {
  return Object.entries(CONFIG.DND5E.abilities)
    .filter(([key]) => key in abilities)
    .map(([key, config]) => {
      const ability = abilities[key];
      return {
        key,
        label: game.i18n.localize(config.label),
        abbr: game.i18n.localize(config.abbreviation).toUpperCase(),
        value: ability.value,
        mod: signed(ability.mod),
        save: signed(ability.save?.value ?? ability.mod),
        saveProficient: ability.proficient > 0
      };
    });
}

/**
 * Habilidades ordenadas alfabéticamente, con su característica y nivel de competencia.
 * @param {object} skills  system.skills
 */
function prepareSkills(skills = {}) {
  return Object.entries(CONFIG.DND5E.skills)
    .filter(([key]) => key in skills)
    .map(([key, config]) => {
      const skill = skills[key];
      const abilityConfig = CONFIG.DND5E.abilities[skill.ability];
      return {
        key,
        label: game.i18n.localize(config.label),
        abbr: abilityConfig ? game.i18n.localize(abilityConfig.abbreviation).toUpperCase() : "",
        total: signed(skill.total),
        prof: proficiencyClass(skill.value)
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));
}

/**
 * Clase CSS según el multiplicador de competencia (0, ½, 1, 2).
 * @param {number} multiplier
 */
function proficiencyClass(multiplier) {
  if ( multiplier >= 2 ) return "expert";
  if ( multiplier >= 1 ) return "proficient";
  if ( multiplier > 0 ) return "half";
  return "none";
}

/**
 * Número con signo: +3, -1, +0.
 * @param {number} value
 * @returns {string}
 */
function signed(value) {
  return dnd5e.utils.formatNumber(value ?? 0, { signDisplay: "always" });
}
