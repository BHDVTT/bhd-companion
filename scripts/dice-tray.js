/**
 * Bandeja de dados de la vista móvil: tiradas libres (3d6 + 1d4 + 2...) desde cualquier pestaña.
 *
 * - Botón con un dado en la cabecera (siempre visible, no tapa la lista) → panel inferior.
 * - Cada toque en d4 / d6 / d8 / d10 / d12 / d20 / d100 añade un dado; la fórmula se ve arriba y se borra con ✕.
 * - Modificador con − / +; con un solo d20, ventaja / normal / desventaja (2d20kh / 2d20kl, como dnd5e).
 * - Pública (todos la ven en el chat) o solo para el DM: el modo de tirada de Foundry (`publicroll` / `gmroll`).
 * - "Tirar": `Roll` de Foundry con los datos del personaje y `toMessage` a su nombre. Dice So Nice la enseña en la
 *   TV (en el teléfono no hay dados 3D). El total sale también en el aviso de la vista.
 * - Las últimas 5 fórmulas quedan como atajos (localStorage de este teléfono).
 */

import { useLog } from "./use-log.js";

/** Dados de la bandeja. */
export const DICE = [4, 6, 8, 10, 12, 20, 100];

/** Atajos guardados. */
const RECENT_KEY = "bhd-companion.diceRecent";
const RECENT_MAX = 5;

export class DiceTray {
  /**
   * @param {object} app  La vista móvil (BHDMobileApp).
   */
  constructor(app) {
    this.app = app;
    this.state = DiceTray.emptyState();
    this.rollMode = "publicroll";
    this.rolling = false;
  }

  /** Bandeja vacía. */
  static emptyState() {
    return { counts: Object.fromEntries(DICE.map(d => [d, 0])), mod: 0, mode: "normal" };
  }

  /**
   * Fórmula de Foundry de un estado: "3d6 + 1d4 + 2"; con un solo d20 y ventaja, "2d20kh".
   * @param {object} state
   * @returns {string}
   */
  static formula(state) {
    const terms = [];
    for ( const die of DICE ) {
      const n = state.counts[die] ?? 0;
      if ( !n ) continue;
      if ( (die === 20) && (n === 1) && (state.mode !== "normal") ) terms.push(state.mode === "advantage" ? "2d20kh" : "2d20kl");
      else terms.push(`${n}d${die}`);
    }
    let formula = terms.join(" + ");
    if ( state.mod ) formula += formula ? ` ${state.mod > 0 ? "+" : "-"} ${Math.abs(state.mod)}` : String(state.mod);
    return formula;
  }

  /** ¿La bandeja está abierta? */
  get isOpen() {
    const panel = this.#panel;
    return !!panel && !panel.hidden;
  }

  /** Panel de la bandeja (se crea la primera vez). */
  get #panel() {
    const root = this.app.element;
    if ( !root ) return null;
    let panel = root.querySelector(":scope > .bhd-dice-tray");
    if ( panel ) return panel;
    panel = document.createElement("div");
    panel.className = "bhd-dice-tray";
    panel.hidden = true;
    panel.addEventListener("click", event => this.#onClick(event));
    panel.addEventListener("change", event => this.#onChange(event));
    root.append(panel);
    return panel;
  }

  /** Abre la bandeja. */
  open() {
    const panel = this.#panel;
    if ( !panel ) return;
    this.#render();
    panel.hidden = false;
    useLog("Bandeja de dados: abierta");
  }

  /** Cierra la bandeja. */
  close() {
    const panel = this.#panel;
    if ( panel ) panel.hidden = true;
  }

  /* -------------------------------------------- */

  /** Atajos guardados en este teléfono. */
  #getRecent() {
    try {
      const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
      return Array.isArray(list) ? list.filter(s => s?.counts).slice(0, RECENT_MAX) : [];
    } catch(err) {
      return [];
    }
  }

  /**
   * Guarda una tirada en los atajos (la más nueva primero, sin repetir).
   * @param {object} state
   */
  #saveRecent(state) {
    const formula = DiceTray.formula(state);
    const list = this.#getRecent().filter(s => DiceTray.formula(s) !== formula);
    list.unshift(foundry.utils.deepClone(state));
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
    } catch(err) {}
  }

  /** Dibuja la bandeja con el estado actual. */
  #render() {
    const panel = this.#panel;
    if ( !panel ) return;
    const escape = foundry.utils.escapeHTML;
    const localize = key => escape(game.i18n.localize(key));
    const state = this.state;
    const formula = DiceTray.formula(state);
    const d20 = state.counts[20] === 1;
    const dice = DICE.map(die => `
      <button type="button" class="bhd-die bhd-die-d${die}" data-die="${die}" aria-label="d${die}">
        <i class="fa-solid ${die === 20 ? "fa-dice-d20" : (die === 6 ? "fa-dice-six" : "fa-dice-d6")}" aria-hidden="true"></i>
        <span>d${die}</span>
        ${state.counts[die] ? `<b class="bhd-die-count">${state.counts[die]}</b>` : ""}
      </button>`).join("");
    const modes = ["advantage", "normal", "disadvantage"].map(mode => `
      <button type="button" class="bhd-chip ${state.mode === mode ? "bhd-on" : ""}" data-mode="${mode}"
              aria-pressed="${state.mode === mode}">${localize(`BHD.Actions.${mode.capitalize()}`)}</button>`).join("");
    const recent = this.#getRecent().map((s, i) => `
      <button type="button" class="bhd-chip bhd-dice-recent" data-recent="${i}">${escape(DiceTray.formula(s))}</button>`).join("");
    const visibility = [["publicroll", "BHD.Dice.Public", "fa-users"], ["gmroll", "BHD.Dice.GM", "fa-user-secret"]].map(([mode, key, icon]) => `
      <button type="button" class="bhd-chip ${this.rollMode === mode ? "bhd-on" : ""}" data-roll-mode="${mode}"
              aria-pressed="${this.rollMode === mode}"><i class="fa-solid ${icon}" aria-hidden="true"></i> ${localize(key)}</button>`).join("");
    panel.innerHTML = `
      <div class="bhd-chooser-backdrop" data-dice-close></div>
      <section class="bhd-dice-sheet" role="dialog" aria-modal="true" aria-label="${localize("BHD.Dice.Title")}">
        <header class="bhd-dice-header">
          <strong>${localize("BHD.Dice.Title")}</strong>
          <button type="button" class="bhd-dice-x" data-dice-close aria-label="${localize("BHD.Actions.Close")}">
            <i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
        </header>
        <div class="bhd-dice-formula">
          <output class="${formula ? "" : "bhd-dice-empty"}">${escape(formula || game.i18n.localize("BHD.Dice.Empty"))}</output>
          <button type="button" class="bhd-dice-clear" data-dice-clear ${formula ? "" : "disabled"}
                  aria-label="${localize("BHD.Dice.Clear")}"><i class="fa-solid fa-delete-left" aria-hidden="true"></i></button>
        </div>
        <div class="bhd-dice-grid">${dice}</div>
        <div class="bhd-dice-row">
          <span class="bhd-dice-label">${localize("BHD.Dice.Modifier")}</span>
          <button type="button" class="bhd-dice-step" data-mod="-1" aria-label="−1">−</button>
          <input type="number" class="bhd-dice-mod" value="${state.mod}" inputmode="numeric" aria-label="${localize("BHD.Dice.Modifier")}">
          <button type="button" class="bhd-dice-step" data-mod="1" aria-label="+1">+</button>
        </div>
        ${d20 ? `<div class="bhd-dice-row bhd-dice-modes" role="group">${modes}</div>` : ""}
        <div class="bhd-dice-row bhd-dice-visibility" role="group" aria-label="${localize("BHD.Dice.Visibility")}">${visibility}</div>
        ${recent ? `<div class="bhd-dice-recents"><span class="bhd-dice-label">${localize("BHD.Dice.Recent")}</span>${recent}</div>` : ""}
        <button type="button" class="bhd-big-btn bhd-dice-roll" data-dice-roll ${formula ? "" : "disabled"}>
          <i class="fa-solid fa-dice" aria-hidden="true"></i> ${localize("BHD.Dice.Roll")}</button>
      </section>`;
  }

  /**
   * Toques en la bandeja.
   * @param {PointerEvent} event
   */
  #onClick(event) {
    const target = event.target.closest("button, [data-dice-close]");
    if ( !target || target.disabled ) return;
    const state = this.state;
    if ( target.matches("[data-dice-close]") ) return this.close();
    if ( target.dataset.die ) {
      const die = Number(target.dataset.die);
      state.counts[die] = Math.min(99, (state.counts[die] ?? 0) + 1);
      try {
        navigator.vibrate?.(10);
      } catch(err) {}
    }
    else if ( target.matches("[data-dice-clear]") ) this.state = DiceTray.emptyState();
    else if ( target.dataset.mod ) state.mod = Math.clamp(state.mod + Number(target.dataset.mod), -99, 99);
    else if ( target.dataset.mode ) state.mode = target.dataset.mode;
    else if ( target.dataset.rollMode ) this.rollMode = target.dataset.rollMode;
    else if ( target.dataset.recent ) {
      const saved = this.#getRecent()[Number(target.dataset.recent)];
      if ( saved ) this.state = { ...DiceTray.emptyState(), ...foundry.utils.deepClone(saved) };
    }
    else if ( target.matches("[data-dice-roll]") ) return this.#roll();
    else return;
    this.#render();
  }

  /**
   * Modificador escrito a mano.
   * @param {Event} event
   */
  #onChange(event) {
    if ( !event.target.matches(".bhd-dice-mod") ) return;
    const value = Math.trunc(Number(event.target.value));
    this.state.mod = Number.isFinite(value) ? Math.clamp(value, -99, 99) : 0;
    this.#render();
  }

  /** Tira la fórmula y la manda al chat a nombre del personaje. */
  async #roll() {
    const formula = DiceTray.formula(this.state);
    if ( !formula || this.rolling ) return;
    this.rolling = true;
    const actor = this.app.actor;
    try {
      const roll = new Roll(formula, actor?.getRollData?.() ?? {});
      await roll.evaluate();
      const rollMode = this.rollMode;
      useLog(`Bandeja de dados: ${formula} = ${roll.total} (${rollMode})`);
      await roll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor }),
        flavor: game.i18n.localize("BHD.Dice.Flavor")
      }, { rollMode });
      this.#saveRecent(this.state);
      this.close();
      this.app.showDiceResult?.(formula, roll);
    } catch(err) {
      console.error("BHD Companion | Bandeja de dados: error al tirar", err);
      ui.notifications.error(game.i18n.format("BHD.Dice.Error", { error: err?.message ?? String(err) }));
    } finally {
      this.rolling = false;
    }
  }
}
