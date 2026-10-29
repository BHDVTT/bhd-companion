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
 * y solo en vista móvil.
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
 * Crea la plantilla en la escena activa, centrada en la ficha del personaje.
 * @param {Activity} activity
 * @param {object} data  Datos de la plantilla preparados por dnd5e.
 * @returns {Promise<MeasuredTemplateDocument|null>}
 */
async function placeTemplate(activity, data) {
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

  const [template] = await scene.createEmbeddedDocuments("MeasuredTemplate", [{
    ...foundry.utils.deepClone(data), x, y
  }]);
  if ( template ) ui.notifications.info("BHD.Actions.TemplatePlaced", { localize: true });
  return template ?? null;
}
