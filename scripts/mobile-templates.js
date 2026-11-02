/**
 * Plantillas de área (bola de fuego, cono de frío...) en la vista móvil.
 *
 * dnd5e coloca las áreas con el ratón sobre el mapa, pero en el teléfono no hay mapa.
 * En su lugar, el área se crea directamente en la escena activa, centrada en la ficha del
 * personaje (o en el centro de la escena si no tiene ficha). En la TV aparece al momento
 * y el DM puede moverla o girarla.
 *
 * - dnd5e 5.x (Foundry v13 y v14): `AbilityTemplate.fromActivity` crea un `MeasuredTemplate`.
 * - dnd5e 6 (Foundry v14): las áreas son Regiones y las crea `TemplatePlacement.fromActivity`.
 *   `AbilityTemplate` sigue existiendo (obsoleto) y template-placement.js lo usa para la vista previa.
 */

/**
 * Permiso para crear áreas: en v14 las plantillas son Regiones (`TEMPLATE_CREATE` ya no existe).
 * @returns {string}
 */
function getTemplatePermission() {
  return (game.release.generation < 14) ? "TEMPLATE_CREATE" : "REGION_CREATE";
}

/**
 * Sustituye `AbilityTemplate.fromActivity` de dnd5e en este cliente. Debe llamarse en "setup"
 * y solo en vista móvil (sin Midi QOL: con Midi el teléfono no usa nada).
 */
export function patchAbilityTemplates() {
  patchRegionPlacement(() => ({}));
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
  patchRegionPlacement(getPlacement);
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
  if ( !game.user.can(getTemplatePermission()) ) {
    ui.notifications.warn("BHD.Actions.TemplateNoPermission", { localize: true });
    return null;
  }

  const { x, y } = getOrigin(findActorToken(activity.actor, scene), scene);
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

/**
 * Ficha del personaje en la escena, si tiene.
 * @param {Actor} actor
 * @param {Scene} scene
 * @returns {TokenDocument|null}
 */
function findActorToken(actor, scene) {
  if ( actor?.token?.parent === scene ) return actor.token;
  return scene.tokens.find(t => t.actorLink && (t.actorId === actor?.id)) ?? null;
}

/**
 * Centro de la ficha o, sin ficha, centro de la escena.
 * @param {TokenDocument|null} token
 * @param {Scene} scene
 * @returns {{x: number, y: number}}
 */
function getOrigin(token, scene) {
  const dims = scene.dimensions;
  return token?.getCenterPoint() ?? {
    x: dims.sceneX + (dims.sceneWidth / 2),
    y: dims.sceneY + (dims.sceneHeight / 2)
  };
}

/* -------------------------------------------- */
/*  dnd5e 6 (Foundry v14): Regiones             */
/* -------------------------------------------- */

/**
 * Sustituye `TemplatePlacement.fromActivity` (dnd5e 6), que espera a que se coloque el área con el ratón.
 * Prepara los mismos datos, con los mismos hooks, y crea la Región sin esperar: en la posición elegida en el
 * teléfono o centrada en la ficha. Sin `TemplatePlacement` (dnd5e 5) no hace nada.
 * @param {function(Activity): (object|null)} getPlacement  Null: como siempre (con el ratón). Si no, la posición
 *   `{ x, y, direction }` (o un objeto vacío: junto a la ficha).
 */
function patchRegionPlacement(getPlacement) {
  const TemplatePlacement = dnd5e.canvas?.TemplatePlacement;
  if ( !TemplatePlacement ) return;
  const original = TemplatePlacement.fromActivity;
  TemplatePlacement.fromActivity = async function(activity, options={}) {
    const placement = getPlacement(activity);
    if ( !placement ) return original.call(this, activity, options);
    return placeRegions(activity, options, placement);
  };
}

/**
 * Lo mismo que `TemplatePlacement.fromActivity` de dnd5e 6, sin el paso del ratón.
 * @param {Activity} activity
 * @param {{createData?: object, placementConfig?: object}} options
 * @param {{x?: number, y?: number, direction?: number}} placement
 * @returns {Promise<RegionDocument[]|null>}
 */
async function placeRegions(activity, { createData={}, placementConfig={} }, placement) {
  const target = activity.target?.template ?? {};
  const templateShape = dnd5e.config.areaTargetTypes[target.type]?.template;
  if ( !templateShape ) return null;
  const scene = game.scenes.active;
  if ( !scene ) {
    ui.notifications.warn("BHD.Actions.TemplateNoScene", { localize: true });
    return null;
  }
  if ( !game.user.can(getTemplatePermission()) ) {
    ui.notifications.warn("BHD.Actions.TemplateNoPermission", { localize: true });
    return null;
  }

  const units = scene.grid.units;
  const convert = value => value ? dnd5e.utils.convertLength(value, target.units, units, { strict: false }) : undefined;
  const templateData = { type: templateShape, size: convert(target.size), width: convert(target.width),
    height: convert(target.height) };
  const config = foundry.utils.mergeObject({
    color: game.user.color,
    shapes: Array.fromRange(target.count || 1).map(() => foundry.utils.deepClone(templateData))
  }, placementConfig);
  if ( Hooks.call("dnd5e.preCreateMeasuredTemplate", activity, config) === false ) return null;

  const token = findActorToken(activity.actor, scene);
  const chosen = Number.isFinite(placement.x) && Number.isFinite(placement.y);
  const shapes = config.shapes.map(s => createShapeData(s, scene, token, chosen ? placement : null)).filter(s => s);
  if ( !shapes.length ) {
    ui.notifications.warn("BHD.Actions.TemplateFailed", { localize: true });
    return null;
  }

  // Igual que dnd5e: las áreas fijas van juntas; las que siguen a la ficha (emanaciones), cada una aparte.
  const attached = !!token && !target.stationary && shapes.some(s => s.type === "emanation");
  const groups = attached ? shapes.map(s => [s]) : [shapes];
  const levelId = token?._source.level ?? scene.initialLevel?.id;
  const rollData = activity.getRollData();
  const regionData = groups.map(group => foundry.utils.mergeObject({
    name: `${activity.item.name} [${game.user.name}]`,
    color: game.user.color,
    shapes: group,
    ...(levelId ? { levels: [levelId] } : {}),
    restriction: { enabled: true, type: "move" },
    attachment: { token: attached ? token.id : undefined },
    visibility: CONST.REGION_VISIBILITY.ALWAYS,
    highlightMode: "coverage",
    flags: {
      dnd5e: {
        activity: activity.uuid,
        dimensions: { size: templateData.size, width: templateData.width, height: templateData.height, units },
        item: activity.item.uuid,
        origin: activity.getUsageToken?.()?.uuid,
        spellLevel: rollData.item?.level
      }
    }
  }, createData));
  if ( Hooks.call("dnd5e.createMeasuredTemplate", activity, regionData) === false ) return null;

  const created = await scene.createEmbeddedDocuments("Region", regionData);
  if ( created.length && !chosen ) ui.notifications.info("BHD.Actions.TemplatePlaced", { localize: true });
  Hooks.callAll("dnd5e.postCreateMeasuredTemplate", activity, created);
  return created;
}

/**
 * Forma de la Región como la crea dnd5e 6, ya colocada: en la posición elegida (origen y dirección, como en la
 * vista previa del teléfono) o sobre la ficha. Los tamaños llegan en unidades de la escena y pasan a píxeles.
 * @param {{type: string, size?: number, width?: number}} shape
 * @param {Scene} scene
 * @param {TokenDocument|null} token
 * @param {{x: number, y: number, direction?: number}|null} placement
 * @returns {object|null}
 */
function createShapeData({ type, size=0, width=0 }, scene, token, placement) {
  const toPixels = scene.grid.size / scene.grid.distance;
  const radius = size * toPixels;
  const breadth = (width || scene.grid.distance) * toPixels;
  const { x, y } = placement ?? getOrigin(token, scene);
  const rotation = placement?.direction ?? 0;
  switch ( type ) {
    case "circle": return { type, x, y, rotation: 0, radius };
    case "cone": return { type, x, y, rotation, radius, angle: CONFIG.MeasuredTemplate?.defaults?.angle ?? 53.13 };
    case "ray":
    case "line": return { type: "line", x, y, rotation, length: radius, width: breadth };
    case "rect":
    case "rectangle":
      // Elegida en el teléfono: esquina en el punto (como el cuadrado de dnd5e). Si no, centrada en la ficha.
      return { type: "rectangle", x: placement ? x : x - (radius / 2), y: placement ? y : y - (radius / 2),
        rotation: 0, width: radius, height: radius };
    case "ring": return { type, x, y, rotation: 0, radius, outerWidth: breadth, innerWidth: 0 };
    case "emanation": {
      if ( !token ) return { type: "circle", x, y, rotation: 0, radius };
      const { x: tx, y: ty, width: w, height: h, shape } = token._source;
      return { type, radius, base: { type: "token", x: tx, y: ty, width: w, height: h, shape } };
    }
  }
  return null;
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
