/**
 * Objetivos desde el teléfono (HUD de la pestaña Combate).
 *
 * Con el mapa cargado (oculto detrás de la vista) y mostrando la escena activa, se marcan las fichas
 * reales con `canvas.tokens.setTargets`, igual que al hacer clic en el mapa: Foundry llena
 * `game.user.targets` con objetos `Token` (los que esperan Automated Animations y otros módulos) y avisa a
 * las demás pantallas. Lo de abajo (`PhoneTarget`) queda por si el mapa no llegó a cargar.
 *
 * Foundry guarda los objetivos del jugador en `game.user.targets`, un conjunto de fichas del mapa.
 * El teléfono no tiene mapa (ni fichas dibujadas), así que se llena con objetos `PhoneTarget` que
 * imitan lo que dnd5e lee de una ficha: id, nombre, actor,
 * documento, posición y tamaño. Con eso dnd5e guarda los objetivos en la tarjeta del chat y compara
 * el ataque con su CA. Además se avisa a las demás pantallas con la actividad del usuario (lo mismo
 * que hace Foundry al marcar un objetivo en el mapa), así la TV y el DM los ven resaltados.
 */

/**
 * Lo que dnd5e y otros módulos esperan de una ficha marcada como objetivo.
 */
class PhoneTarget {
  /** @param {TokenDocument} document */
  constructor(document) {
    this.document = document;
  }

  get id() { return this.document.id; }
  get name() { return this.document.name; }
  get actor() { return this.document.actor; }
  get scene() { return this.document.parent; }
  get x() { return this.document.x; }
  get y() { return this.document.y; }
  get w() { return this.document.getSize().width; }
  get h() { return this.document.getSize().height; }
  get center() { return this.document.getCenterPoint(); }
  get visible() { return true; }
  get isVisible() { return true; }
  /** dnd5e hace parpadear el anillo de la ficha al marcarla: aquí no hay anillo que dibujar. */
  get hasDynamicRing() { return false; }
}

/**
 * Ids de las fichas marcadas como objetivo por este jugador.
 * @returns {string[]}
 */
export function getTargetIds() {
  return game.user.targets.ids;
}

/**
 * Marca exactamente estas fichas de la escena activa (la de la TV) como objetivos.
 * @param {string[]} ids
 */
export function setTargets(ids) {
  const scene = game.scenes.active;
  if ( canvas?.ready && scene && (canvas.scene === scene) ) {
    // Quita los PhoneTarget que quedaran (p. ej. de antes de que el mapa terminara de cargar).
    for ( const target of Array.from(game.user.targets) ) {
      if ( target instanceof PhoneTarget ) game.user.targets.delete(target);
    }
    canvas.tokens.setTargets(ids.filter(id => canvas.tokens.get(id)), { mode: "replace" });
    broadcastTargets();   // con la escena, para que la TV los dibuje
    return;
  }
  const tokens = scene ? ids.map(id => scene.tokens.get(id)).filter(t => t) : [];
  const targets = game.user.targets;
  for ( const target of Array.from(targets) ) {
    if ( !tokens.includes(target.document) ) targets.delete(target);
  }
  for ( const token of tokens ) {
    if ( !Array.from(targets).some(t => t.document === token) ) targets.add(new PhoneTarget(token));
  }
  broadcastTargets();
}

/**
 * Marca o desmarca una ficha sin tocar los demás objetivos.
 * @param {string} id
 */
export function toggleTarget(id) {
  const ids = getTargetIds();
  setTargets(ids.includes(id) ? ids.filter(i => i !== id) : [...ids, id]);
}

/**
 * Quita los objetivos que ya no existen o que no están en la escena activa
 * (ficha borrada, el DM cambió de escena...).
 */
export function pruneTargets() {
  const scene = game.scenes.active;
  const valid = getTargetIds().filter(id => scene?.tokens.has(id));
  if ( valid.length !== game.user.targets.size ) setTargets(valid);
}

/**
 * Avisa a las demás pantallas de los objetivos de este jugador. Foundry solo los dibuja si el
 * jugador "está viendo" esa escena, así que se manda también la escena activa.
 */
export function broadcastTargets() {
  const sceneId = game.scenes.active?.id ?? null;
  game.user.broadcastActivity({ sceneId, targets: getTargetIds() });
}
