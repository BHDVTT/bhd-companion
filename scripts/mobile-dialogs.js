/**
 * Ventanas de dnd5e más compactas en la vista móvil.
 *
 * Las ventanas de usar una actividad (nivel del espacio, concentración, recursos, área) y de
 * configurar una tirada (fórmula, bonificador, modo de tirada) se adaptan al teléfono:
 * lo importante queda a la vista y el resto se pliega bajo un botón que se puede abrir.
 * El aspecto (ancho, letra, botones grandes) está en el CSS, bajo `.bhd-compact`.
 */

/**
 * Secciones plegadas por ventana. La clave es la parte de la plantilla de dnd5e
 * (`data-application-part`). Lo que no aparece aquí (p. ej. "scaling", el nivel del espacio,
 * o "buttons", Ventaja / Normal / Desventaja) se queda siempre a la vista.
 */
const FOLDED_PARTS = {
  "activity-usage": ["concentration", "consumption", "creation"],
  "roll-configuration": ["formulas", "configuration"]
};

/**
 * Secciones que el jugador abrió en cada ventana, para que no se vuelvan a plegar cuando
 * dnd5e redibuja la ventana al cambiar una opción.
 * @type {WeakMap<ApplicationV2, Set<string>>}
 */
const openedParts = new WeakMap();

/**
 * Activa las ventanas compactas. Debe llamarse en "setup" y solo en vista móvil.
 */
export function registerCompactDialogs() {
  Hooks.on("renderDialog5e", onRenderDialog);
}

/**
 * @param {ApplicationV2} app
 * @param {HTMLElement} element
 */
function onRenderDialog(app, element) {
  element.classList.add("bhd-compact");
  for ( const [cssClass, parts] of Object.entries(FOLDED_PARTS) ) {
    if ( !element.classList.contains(cssClass) ) continue;
    for ( const partId of parts ) {
      const part = element.querySelector(`[data-application-part="${partId}"]`);
      if ( part ) makeFoldable(app, part, partId);
    }
  }
}

/**
 * Pliega una sección y le pone encima un botón con su título para abrirla o cerrarla.
 * No se pliega si está vacía o si muestra un aviso (p. ej. "no te quedan usos").
 * @param {ApplicationV2} app
 * @param {HTMLElement} part
 * @param {string} partId
 */
function makeFoldable(app, part, partId) {
  if ( part.querySelector(":scope > .bhd-fold-toggle") ) return;
  if ( !part.querySelector("input, select, range-picker") ) return;
  if ( part.querySelector(".warning, .notes .warn, [data-tooltip-class*=warning]") ) return;
  // Elegir el tipo de daño (p. ej. Orbe cromático) es importante: no se pliega.
  if ( part.querySelector("select[name$='.damageType']") ) return;

  const legends = [...part.querySelectorAll("legend")].map(l => l.textContent.trim()).filter(_ => _);
  let label = legends.join(" · ") || game.i18n.localize(`BHD.Dialogs.${partId.capitalize()}`);
  // La fórmula se ve aunque esté plegada: "Fórmula y bonificador: 1d20 + 5".
  const formulas = [...part.querySelectorAll(".formula")].map(f => f.textContent.trim()).filter(_ => _);
  if ( formulas.length ) label += `: ${formulas.join(", ")}`;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "bhd-fold-toggle";
  toggle.innerHTML = `<span></span><i class="fa-solid fa-chevron-down" aria-hidden="true"></i>`;
  toggle.querySelector("span").textContent = label;
  part.prepend(toggle);
  part.classList.add("bhd-foldable");

  const opened = openedParts.get(app) ?? new Set();
  openedParts.set(app, opened);
  const setOpen = open => {
    part.classList.toggle("bhd-folded", !open);
    toggle.setAttribute("aria-expanded", String(open));
  };
  setOpen(opened.has(partId));
  toggle.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    const open = part.classList.contains("bhd-folded");
    if ( open ) opened.add(partId);
    else opened.delete(partId);
    setOpen(open);
  });
}
