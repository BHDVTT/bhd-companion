/**
 * Plantillas de área (bola de fuego, cono de frío...) en la vista móvil.
 *
 * dnd5e coloca las áreas con el ratón sobre el mapa, pero en el teléfono no hay mapa.
 * En su lugar, el área se crea directamente en la escena activa, centrada en la ficha del
 * personaje (o en el centro de la escena si no tiene ficha). En la TV aparece al momento
 * y el DM puede moverla o girarla.
 */

/**
 * Sustituye `AbilityTemplate.fromActivity` de dnd5e en este cliente. Debe llamarse en "setup"
 * y solo en vista móvil (sin Midi QOL: con Midi el teléfono no usa nada).
 */
export function patchAbilityTemplates() {
  const AbilityTemplate = dnd5e.canvas?.AbilityTemplate;
  if ( !AbilityTemplate ) return;
  const original = AbilityTemplate.fromActivity;

  AbilityTemplate.fromActivity = function(activity, options={}) {
    // dnd5e calcula los datos del área y avisa con este hook antes de dibujarla en el mapa:
    // los guardamos y cancelamos el dibujo (no hay mapa).
    let templateData;
    const hookId = Hooks.on("dnd5e.preCreateActivityTemplate", (a, data) => {
      if ( a !== activity ) return;
      templateData = data;
      return false;
    });
    try {
      original.call(this, activity, options);
    } catch(err) {
      console.error("BHD Companion | No se pudieron preparar los datos del área", err);
    } finally {
      Hooks.off("dnd5e.preCreateActivityTemplate", hookId);
    }
    if ( !templateData ) {
      if ( activity.target?.template?.type ) ui.notifications.warn("BHD.Actions.TemplateFailed", { localize: true });
      return [];
    }

    // dnd5e espera objetos con drawPreview() que devuelven la plantilla creada.
    const count = activity.target.template.count || 1;
    return Array.fromRange(count).map(() => ({
      drawPreview: () => placeTemplate(activity, templateData)
    }));
  };
}

/**
 * Cliente del DM con Midi QOL: las áreas de los usos que pide un teléfono se colocan solas donde las colocó el
 * jugador en su teléfono (template-placement.js) o, si no, centradas en su ficha (el DM no hace clic en el mapa).
 * dnd5e prepara el área como siempre (Midi lee su documento); solo cambia `drawPreview`, el paso que espera al
 * ratón. Las áreas que Midi coloca por su cuenta (emanaciones, trampas) no llaman a `drawPreview`. Llamar en "setup".
 * @param {function(Activity): (object|null)} getPlacement  Null si no es un uso del teléfono; si lo es, la
 *   posición elegida `{ x, y, direction }` (o un objeto vacío: junto a la ficha).
 */
export function patchGmTemplatePlacement(getPlacement) {
  const AbilityTemplate = dnd5e.canvas?.AbilityTemplate;
  if ( !AbilityTemplate ) return;
  const original = AbilityTemplate.fromActivity;
  AbilityTemplate.fromActivity = function(activity, options={}) {
    const templates = original.call(this, activity, options);
    const placement = getPlacement(activity);
    if ( !placement || !Array.isArray(templates) ) return templates;
    for ( const template of templates ) {
      template.drawPreview = () => {
        const where = Number.isFinite(placement.x) ? "donde la colocó el jugador" : "junto a la ficha";
        console.log(`BHD Companion | Área de ${activity.item?.name} colocada ${where} (uso del teléfono)`, placement);
        return placeTemplate(activity, template.document.toObject(), placement);
      };
    }
    return templates;
  };
}

/**
 * Crea la plantilla en la escena activa: en la posición dada o centrada en la ficha del personaje.
 * @param {Activity} activity
 * @param {object} data  Datos de la plantilla preparados por dnd5e.
 * @param {{x?: number, y?: number, direction?: number}} [placement]  Posición elegida en el teléfono.
 * @returns {Promise<MeasuredTemplateDocument|null>}
 */
async function placeTemplate(activity, data, placement={}) {
  const scene = game.scenes.active;
  if ( !scene ) {
    ui.notifications.warn("BHD.Actions.TemplateNoScene", { localize: true });
    return null;
  }
  if ( !game.user.can("TEMPLATE_CREATE") ) {
    ui.notifications.warn("BHD.Actions.TemplateNoPermission", { localize: true });
    return null;
  }

  const actor = activity.actor;
  const token = (actor?.token?.parent === scene) ? actor.token
    : scene.tokens.find(t => t.actorLink && (t.actorId === actor?.id));
  const dims = scene.dimensions;
  const { x, y } = token?.getCenterPoint() ?? {
    x: dims.sceneX + (dims.sceneWidth / 2),
    y: dims.sceneY + (dims.sceneHeight / 2)
  };

  const chosen = Number.isFinite(placement.x) && Number.isFinite(placement.y);
  const position = chosen ? { x: placement.x, y: placement.y } : { x, y };
  if ( Number.isFinite(placement.direction) ) position.direction = placement.direction;
  if ( placement.fillColor ) position.fillColor = placement.fillColor;
  const [template] = await scene.createEmbeddedDocuments("MeasuredTemplate", [{
    ...foundry.utils.deepClone(data), ...position
  }]);
  if ( template && !chosen ) ui.notifications.info("BHD.Actions.TemplatePlaced", { localize: true });
  return template ?? null;
}

/* -------------------------------------------- */
/*  Invocaciones                                */
/* -------------------------------------------- */

/** Casillas alrededor de la ficha que se prueban para colocar una criatura invocada. */
const SUMMON_SEARCH_RINGS = 8;

/**
 * Criaturas invocadas (actividad "Invocar" de dnd5e). dnd5e las coloca con `TokenPlacement.place`, que espera
 * a que el jugador haga clic en el mapa; en el teléfono el mapa está oculto y se quedaría esperando. Aquí se
 * colocan solas en las casillas libres más cercanas a la ficha del personaje (el DM las mueve en la TV).
 * El resto lo hace dnd5e igual que siempre (qué criatura, cuántas, sus cambios). Llamar en "setup": en vista
 * móvil (sin Midi), o en el DM con Midi para los usos que pide un teléfono.
 * @param {function(object): boolean} [shouldPlace]  ¿Colocar solas estas fichas? Si no, como siempre (clic).
 */
export function patchTokenPlacement(shouldPlace=() => true) {
  const TokenPlacement = dnd5e.canvas?.TokenPlacement;
  if ( !TokenPlacement ) return;
  const original = TokenPlacement.place;
  TokenPlacement.place = async function(config) {
    if ( !shouldPlace(config) ) return original.call(this, config);
    const scene = canvas.scene;
    if ( !scene ) return [];
    const spots = findFreeSpots(scene, config.origin ?? null, config.tokens);
    const counts = new Map();
    const placements = config.tokens.map((prototypeToken, total) => {
      const actorId = prototypeToken.parent?.id;
      counts.set(actorId, (counts.get(actorId) ?? -1) + 1);
      return {
        prototypeToken,
        index: { total, unique: counts.get(actorId) },
        x: spots[total].x,
        y: spots[total].y,
        elevation: config.origin?.elevation ?? 0,
        rotation: prototypeToken.rotation ?? 0
      };
    });
    if ( placements.length ) ui.notifications.info("BHD.Actions.SummonPlaced", { localize: true });
    return placements;
  };
}

/**
 * Esquinas (arriba a la izquierda) de casillas libres alrededor de una ficha, una por ficha a colocar.
 * Una casilla está libre si la nueva ficha no se solapa con ninguna otra ni sale de la escena.
 * @param {Scene} scene
 * @param {TokenDocument|null} origin
 * @param {PrototypeToken[]} tokens
 * @returns {{x: number, y: number}[]}
 */
function findFreeSpots(scene, origin, tokens) {
  const grid = scene.grid;
  const rect = scene.dimensions.sceneRect;
  const box = (x, y, w, h) => ({ x0: x, y0: y, x1: x + (w * grid.sizeX), y1: y + (h * grid.sizeY) });
  const taken = scene.tokens.map(t => box(t.x, t.y, t.width, t.height));
  const overlaps = (a, b) => (a.x0 < b.x1) && (b.x0 < a.x1) && (a.y0 < b.y1) && (b.y0 < a.y1);
  const center = origin?.getCenterPoint() ?? { x: rect.x + (rect.width / 2), y: rect.y + (rect.height / 2) };
  const start = grid.getOffset(center);

  return tokens.map(token => {
    const width = token.width ?? 1;
    const height = token.height ?? 1;
    for ( let ring = 1; ring <= SUMMON_SEARCH_RINGS; ring++ ) {
      for ( let di = -ring; di <= ring; di++ ) {
        for ( let dj = -ring; dj <= ring; dj++ ) {
          if ( Math.max(Math.abs(di), Math.abs(dj)) !== ring ) continue;
          const point = grid.getTopLeftPoint({ i: start.i + di, j: start.j + dj });
          const spot = box(point.x, point.y, width, height);
          const inside = (spot.x0 >= rect.x) && (spot.y0 >= rect.y) && (spot.x1 <= rect.x + rect.width)
            && (spot.y1 <= rect.y + rect.height);
          if ( !inside || taken.some(t => overlaps(t, spot)) ) continue;
          taken.push(spot);
          return { x: point.x, y: point.y };
        }
      }
    }
    // Sin sitio cerca: encima de la ficha (el DM la mueve).
    const point = grid.getTopLeftPoint(start);
    return { x: point.x, y: point.y };
  });
}
