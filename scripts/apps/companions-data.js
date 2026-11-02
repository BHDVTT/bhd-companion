/**
 * Compañeros e invocaciones del jugador: fichas de la escena de la TV de las que es dueño y que no son uno de sus
 * personajes (familiar, montura de Find Steed, compañero animal, criaturas de una actividad Invocar de dnd5e o de
 * otros módulos). No se buscan por nombre ni por rasgo: solo cuenta que Foundry le dé al jugador la propiedad
 * (OWNER) de la ficha. Cuando la ficha se borra (fin de la concentración o de la duración), deja de estar.
 */

import { getCharacterChoices } from "./character-data.js";

/**
 * Fichas de compañeros en la escena activa (la de la TV), por nombre.
 * @returns {TokenDocument[]}
 */
export function getCompanionTokens() {
  const scene = game.scenes.active;
  if ( !scene || game.user.isGM ) return [];
  const characters = new Set(getCharacterChoices());
  return scene.tokens
    .filter(token => {
      const actor = token.actor;
      if ( !actor || !token.isOwner ) return false;
      // Su personaje (ficha vinculada o una copia del mismo personaje) no es un compañero.
      if ( characters.has(actor) || (actor.type === "character" && characters.has(game.actors.get(token.actorId))) ) {
        return false;
      }
      return actor.type !== "group";
    })
    .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
}

/**
 * Actor del compañero elegido, o null si su ficha ya no existe en la escena activa o el jugador dejó de ser dueño.
 * @param {string|null} tokenUuid
 * @returns {Actor|null}
 */
export function getCompanionActor(tokenUuid) {
  if ( !tokenUuid ) return null;
  const token = getCompanionTokens().find(t => t.uuid === tokenUuid);
  return token?.actor ?? null;
}

/**
 * Selector de la cabecera: el personaje y cada compañero. Null si no hay compañeros.
 * @param {Actor|null} character
 * @param {string|null} selectedUuid  Ficha del compañero elegido (null: el personaje).
 * @returns {object[]|null}
 */
export function prepareCompanionChoices(character, selectedUuid) {
  const tokens = getCompanionTokens();
  if ( !tokens.length || !character ) return null;
  const hp = actor => {
    const { value, max } = actor.system.attributes?.hp ?? {};
    return Number.isFinite(max) && max ? `${value ?? 0}/${max}` : "";
  };
  return [
    { uuid: "", name: character.name, img: character.img, hp: hp(character), active: !selectedUuid, character: true },
    ...tokens.map(token => ({
      uuid: token.uuid,
      name: token.name,
      img: token.texture?.src || token.actor.img,
      hp: hp(token.actor),
      active: token.uuid === selectedUuid,
      character: false
    }))
  ];
}
