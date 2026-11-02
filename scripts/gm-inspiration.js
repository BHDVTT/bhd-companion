/**
 * Botón rápido del DM para dar o quitar Inspiración: una estrella junto a cada jugador en la lista de jugadores de
 * Foundry (abajo a la izquierda). Cambia `system.attributes.inspiration` del personaje asignado al jugador; el
 * teléfono del jugador lo ve en el cambio del actor y avisa con vibración.
 */

/**
 * Activa la estrella en la lista de jugadores. Llamar en "ready", solo en el cliente del DM.
 */
export function registerGmInspiration() {
  Hooks.on("renderPlayers", (app, element) => addStars(element));
  // La estrella se rellena o se vacía al cambiar la inspiración de un personaje.
  Hooks.on("updateActor", (actor, changes) => {
    if ( foundry.utils.hasProperty(changes, "system.attributes.inspiration") ) ui.players?.render();
  });
  ui.players?.render();
}

/**
 * @param {HTMLElement} element  Lista de jugadores.
 */
function addStars(element) {
  for ( const row of element.querySelectorAll(".player[data-user-id]") ) {
    const user = game.users.get(row.dataset.userId);
    const actor = user?.character;
    if ( !user || user.isGM || !actor || (actor.type !== "character") ) continue;
    row.querySelector(".bhd-gm-inspiration")?.remove();
    const active = !!actor.system.attributes?.inspiration;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `bhd-gm-inspiration ${active ? "bhd-on" : ""}`;
    button.innerHTML = `<i class="fa-${active ? "solid" : "regular"} fa-star" aria-hidden="true"></i>`;
    const label = game.i18n.format(active ? "BHD.Inspiration.GMRemove" : "BHD.Inspiration.GMGive", { name: actor.name });
    button.dataset.tooltip = label;
    button.setAttribute("aria-label", label);
    button.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      const give = !actor.system.attributes?.inspiration;
      console.log(`BHD Companion | DM: ${give ? "da" : "quita"} Inspiración a ${actor.name} (${user.name})`);
      await actor.update({ "system.attributes.inspiration": give });
    });
    row.append(button);
  }
}
