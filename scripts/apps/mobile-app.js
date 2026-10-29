import { MODULE_ID, TEMPLATE_PATH } from "../constants.js";
import { getActiveCharacter, getCharacterChoices, prepareCharacterSheet } from "./character-data.js";
import { ACTION_FILTERS, normalizeSearch, prepareActions } from "./actions-data.js";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

/** Cuánto tiempo (ms) se ve el resultado de una tirada en el teléfono. */
const TOAST_DURATION = 4000;

/**
 * Vista móvil a pantalla completa: encabezado, contenido por pestañas y barra de pestañas abajo.
 */
export class BHDMobileApp extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "bhd-mobile-app",
    classes: ["bhd-app"],
    tag: "div",
    window: {
      frame: false,
      positioned: false
    },
    actions: {
      bhdTab: BHDMobileApp.#onTab,
      exitMobile: BHDMobileApp.#onExitMobile,
      roll: BHDMobileApp.#onRoll,
      hpStep: BHDMobileApp.#onHpStep,
      hpApply: BHDMobileApp.#onHpApply,
      toggleInspiration: BHDMobileApp.#onToggleInspiration,
      useItem: BHDMobileApp.#onUseItem,
      itemInfo: BHDMobileApp.#onItemInfo,
      actionFilter: BHDMobileApp.#onActionFilter,
      closeTray: BHDMobileApp.#onCloseTray
    }
  };

  static PARTS = {
    header: { template: `${TEMPLATE_PATH}/mobile/header.hbs` },
    main: {
      template: `${TEMPLATE_PATH}/mobile/main.hbs`,
      templates: [
        `${TEMPLATE_PATH}/mobile/character.hbs`,
        `${TEMPLATE_PATH}/mobile/actions.hbs`,
        `${TEMPLATE_PATH}/mobile/action-row.hbs`
      ],
      scrollable: [""]
    },
    nav: { template: `${TEMPLATE_PATH}/mobile/nav.hbs` }
  };

  static TABS = {
    primary: {
      initial: "character",
      labelPrefix: "BHD.Tabs",
      tabs: [
        { id: "character", icon: "fa-solid fa-user" },
        { id: "actions", icon: "fa-solid fa-hand-fist" },
        { id: "combat", icon: "fa-solid fa-swords" },
        { id: "inventory", icon: "fa-solid fa-sack" },
        { id: "notes", icon: "fa-solid fa-scroll" }
      ]
    }
  };

  /** Cantidad escrita en el control de vida (se conserva si la vista se vuelve a dibujar). */
  #hpAmount = "";

  /** ¿Hay una tirada en curso? Evita tiradas dobles por tocar dos veces. */
  #rolling = false;

  /** Temporizador del aviso con el resultado de la tirada. */
  #toastTimeout;

  /** Filtro de la pestaña Acciones: "all", "action", "bonus" o "reaction". */
  #actionFilter = "all";

  /** Texto del buscador de hechizos. */
  #spellSearch = "";

  /** ¿Se está usando un objeto? Evita usos dobles por tocar dos veces. */
  #using = false;

  /**
   * Mensajes del chat que se ven en el panel de resultados: la tarjeta del último objeto usado
   * y las tiradas que salen de ella (ataque, daño...).
   * @type {string[]}
   */
  #trayMessages = [];

  /** Contador para descartar dibujos del panel que ya quedaron viejos. */
  #trayRender = 0;

  /**
   * Personaje que se muestra ahora mismo.
   * @type {Actor|null}
   */
  get actor() {
    return getActiveCharacter();
  }

  /* -------------------------------------------- */

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const actor = this.actor;
    context.userName = game.user.name;
    context.character = actor ? { name: actor.name, img: actor.img } : null;
    context.sheet = actor ? prepareCharacterSheet(actor) : null;
    context.hpAmount = this.#hpAmount;
    context.actions = actor ? prepareActions(actor) : null;
    context.spellSearch = this.#spellSearch;
    context.actionFilters = ["all", ...ACTION_FILTERS].map(id => ({
      id,
      label: game.i18n.localize(`BHD.Actions.Filter${id.capitalize()}`),
      active: id === this.#actionFilter
    }));

    const choices = getCharacterChoices();
    context.choices = (choices.length > 1) ? choices.map(a => ({
      id: a.id, name: a.name, selected: a === actor
    })) : null;
    return context;
  }

  /* -------------------------------------------- */

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);

    // Panel de resultados (tarjeta del último objeto usado). Va fuera de las partes de la plantilla
    // para que no se borre cuando la vista se vuelve a dibujar.
    const tray = document.createElement("section");
    tray.className = "bhd-tray";
    tray.hidden = true;
    tray.innerHTML = `
      <header class="bhd-tray-header">
        <span class="bhd-tray-title">${game.i18n.localize("BHD.Actions.LastUse")}</span>
        <button type="button" class="bhd-tray-close" data-action="closeTray"
                aria-label="${game.i18n.localize("BHD.Actions.Close")}">
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
      </header>
      <ol class="chat-log themed theme-dark bhd-tray-log"></ol>`;
    this.element.append(tray);

    const toast = document.createElement("div");
    toast.className = "bhd-toast";
    toast.setAttribute("role", "status");
    toast.hidden = true;
    this.element.append(toast);
  }

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);
    const amount = this.element.querySelector("[data-bhd-hp-amount]");
    amount?.addEventListener("input", event => this.#hpAmount = event.currentTarget.value);
    const select = this.element.querySelector("[data-bhd-character-select]");
    select?.addEventListener("change", event => game.user.update({ character: event.currentTarget.value }));
    const search = this.element.querySelector("[data-bhd-spell-search]");
    search?.addEventListener("input", event => {
      this.#spellSearch = event.currentTarget.value;
      this.#applyActionFilters();
    });
    this.#applyActionFilters();
  }

  /* -------------------------------------------- */
  /*  Pestaña Acciones                            */
  /* -------------------------------------------- */

  /**
   * Muestra u oculta filas de la pestaña Acciones según el filtro y el buscador de hechizos.
   * Se hace sin volver a dibujar la vista para que escribir en el buscador sea instantáneo.
   */
  #applyActionFilters() {
    const root = this.element?.querySelector(".bhd-actions");
    if ( !root ) return;
    const filter = this.#actionFilter;
    const query = normalizeSearch(this.#spellSearch);
    const filtering = filter !== "all";

    for ( const row of root.querySelectorAll(".bhd-action") ) {
      const matchesFilter = !filtering || row.dataset.activation.split(" ").includes(filter);
      const isSpell = !!row.closest("[data-spell-section]");
      const matchesSearch = !isSpell || !query || row.dataset.search.includes(query);
      row.classList.toggle("bhd-filtered-out", !matchesFilter);
      row.hidden = !matchesFilter || !matchesSearch;
    }

    // Niveles de hechizo: se ocultan si al filtrar o buscar se quedan vacíos.
    for ( const section of root.querySelectorAll("[data-spell-section]") ) {
      const empty = !section.querySelector(".bhd-action:not([hidden])");
      section.hidden = (filtering || !!query) && empty;
    }

    // Grupos principales: se ocultan si el filtro los deja vacíos (el de hechizos conserva el buscador).
    let anyGroup = false;
    for ( const group of root.querySelectorAll(":scope > .bhd-action-group") ) {
      const isSpells = group.classList.contains("bhd-spells");
      const selector = isSpells ? ".bhd-action:not(.bhd-filtered-out)" : ".bhd-action:not([hidden])";
      group.hidden = filtering && !group.querySelector(selector);
      if ( !group.hidden ) anyGroup = true;
      if ( isSpells ) {
        const noSpells = group.querySelector("[data-bhd-no-spells]");
        if ( noSpells ) noSpells.hidden = !query || !!group.querySelector(".bhd-action:not([hidden])");
      }
    }
    const none = root.querySelector("[data-bhd-no-actions]");
    if ( none ) none.hidden = anyGroup;
  }

  /* -------------------------------------------- */

  /**
   * Abre el panel de resultados con la tarjeta de un objeto recién usado.
   * @param {ChatMessage} message
   */
  #openTray(message) {
    this.#trayMessages = [message.id];
    this.#renderTray();
  }

  /**
   * Dibuja en el panel las tarjetas del chat: la del objeto usado y sus tiradas.
   * Son las mismas tarjetas de dnd5e que se ven en el chat, con sus botones (daño, salvación...).
   */
  async #renderTray() {
    const tray = this.element?.querySelector(".bhd-tray");
    if ( !tray ) return;
    const renderId = ++this.#trayRender;
    const messages = this.#trayMessages.map(id => game.messages.get(id)).filter(m => m?.visible);
    if ( !messages.length ) {
      tray.hidden = true;
      return;
    }
    const elements = [];
    for ( const message of messages ) {
      try {
        elements.push(await message.renderHTML());
      } catch(err) {
        console.error("BHD Companion | No se pudo mostrar la tarjeta del chat", err);
      }
    }
    if ( renderId !== this.#trayRender ) return;
    const log = tray.querySelector(".bhd-tray-log");
    log.replaceChildren(...elements);
    const wasHidden = tray.hidden;
    tray.hidden = false;
    // Muestra lo más reciente (la última tirada).
    if ( wasHidden ) log.scrollTop = 0;
    else elements.at(-1)?.scrollIntoView({ block: "nearest" });
  }

  /**
   * Llamado desde los hooks del chat: añade al panel las tiradas que salen de la tarjeta
   * mostrada y lo actualiza si alguna de sus tarjetas cambia o se borra.
   * @param {ChatMessage} message
   * @param {"create"|"update"|"delete"} action
   */
  onChatMessage(message, action) {
    if ( !this.#trayMessages.length ) return;
    if ( action === "create" ) {
      const origin = message.getFlag("dnd5e", "originatingMessage");
      if ( !this.#trayMessages.includes(origin) ) return;
      this.#trayMessages.push(message.id);
    }
    else if ( !this.#trayMessages.includes(message.id) ) return;
    else if ( action === "delete" ) this.#trayMessages.findSplice(id => id === message.id);
    this.#renderTray();
  }

  /**
   * Llamado desde los hooks de tiradas de dnd5e: muestra en el teléfono el total de un ataque o daño
   * hecho por este personaje.
   * @param {"attack"|"damage"} type
   * @param {Roll[]} rolls
   * @param {Activity} [subject]
   */
  onActivityRoll(type, rolls, subject) {
    const actor = this.actor;
    if ( !actor || !rolls?.length || (subject?.actor !== actor) ) return;
    const name = subject.item?.name ?? "";
    if ( type === "attack" ) {
      this.#showRollResult(`${name}: ${game.i18n.localize("BHD.Actions.Attack")}`, rolls[0]);
      return;
    }
    const total = rolls.reduce((sum, roll) => sum + (roll.total ?? 0), 0);
    const label = subject.damageFlavor ?? game.i18n.localize("BHD.Actions.Damage");
    this.#showRollResult(`${name}: ${label}`, { total });
  }

  /* -------------------------------------------- */

  /**
   * La vista móvil no se cierra con Escape ni por accidente. Para cerrarla de verdad,
   * pasar { bhdForce: true }.
   * @override
   */
  async close(options = {}) {
    if ( !options.bhdForce ) return this;
    return super.close(options);
  }

  /* -------------------------------------------- */

  /**
   * Muestra unos segundos el resultado de una tirada en el propio teléfono
   * (el mensaje completo va al chat de Foundry, visible en la TV).
   * @param {string} label
   * @param {Roll} [roll]
   */
  #showRollResult(label, roll) {
    const toast = this.element.querySelector(".bhd-toast");
    if ( !toast || !roll ) return;
    toast.classList.toggle("bhd-crit", !!roll.isCritical);
    toast.classList.toggle("bhd-fumble", !!roll.isFumble);
    toast.innerHTML = `<span class="bhd-toast-label"></span><span class="bhd-toast-total">${roll.total}</span>`;
    toast.querySelector(".bhd-toast-label").textContent = label;
    toast.hidden = false;
    clearTimeout(this.#toastTimeout);
    this.#toastTimeout = setTimeout(() => toast.hidden = true, TOAST_DURATION);
  }

  /**
   * Tira iniciativa. Si el personaje ya está en el combate activo y no tiene iniciativa,
   * la tirada se guarda en el combate; si no, simplemente sale en el chat.
   * @param {Actor} actor
   * @returns {Promise<{total: number}|null>}
   */
  async #rollInitiative(actor) {
    const combat = game.combat;
    const combatant = combat?.getCombatantsByActor(actor).find(c => c.isOwner && (c.initiative === null));
    if ( combatant ) {
      await combat.rollInitiative([combatant.id]);
      const initiative = combat.combatants.get(combatant.id)?.initiative;
      return Number.isFinite(initiative) ? { total: initiative } : null;
    }
    const roll = actor.getInitiativeRoll();
    if ( !roll ) return null;
    await roll.evaluate();
    await roll.toMessage({
      speaker: ChatMessage.implementation.getSpeaker({ actor }),
      flavor: game.i18n.localize("BHD.Sheet.InitiativeRoll")
    });
    return roll;
  }

  /* -------------------------------------------- */
  /*  Acciones                                    */
  /* -------------------------------------------- */

  /**
   * Cambia de pestaña. Usamos nuestra propia acción en lugar de la de Foundry porque la de Foundry
   * falla cuando se toca el icono o el texto dentro del botón.
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onTab(event, target) {
    this.changeTab(target.dataset.tab, target.dataset.group, { event });
  }

  /**
   * Tira una característica, salvación, habilidad o iniciativa con las funciones de dnd5e.
   * De momento sin ventana de opciones: un toque = una tirada normal.
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onRoll(event, target) {
    const actor = this.actor;
    if ( !actor || this.#rolling ) return;
    const { type, key, label } = target.dataset;
    const dialog = { configure: false };
    this.#rolling = true;
    target.classList.add("bhd-rolling");
    try {
      let rolls;
      switch ( type ) {
        case "ability": rolls = await actor.rollAbilityCheck({ ability: key, event }, dialog); break;
        case "save": rolls = await actor.rollSavingThrow({ ability: key, event }, dialog); break;
        case "skill": rolls = await actor.rollSkill({ skill: key, event }, dialog); break;
        case "initiative": rolls = [await this.#rollInitiative(actor)]; break;
      }
      this.#showRollResult(label, rolls?.[0]);
    } finally {
      this.#rolling = false;
      target.classList.remove("bhd-rolling");
    }
  }

  /**
   * Botones − / + junto a la cantidad de vida.
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onHpStep(event, target) {
    const input = this.element.querySelector("[data-bhd-hp-amount]");
    const current = parseInt(input.value) || 0;
    const value = Math.max(current + Number(target.dataset.step), 0);
    input.value = this.#hpAmount = value ? String(value) : "";
  }

  /**
   * Aplica la cantidad escrita como daño, curación o vida temporal.
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onHpApply(event, target) {
    const actor = this.actor;
    const amount = parseInt(this.element.querySelector("[data-bhd-hp-amount]")?.value);
    if ( !actor || !(amount > 0) ) return;
    const mode = target.dataset.mode;
    if ( (mode === "temp") && (amount <= (actor.system.attributes.hp.temp ?? 0)) ) {
      ui.notifications.info("BHD.Sheet.HP.TempNotHigher", { localize: true });
      return;
    }
    this.#hpAmount = "";
    if ( mode === "damage" ) await actor.applyDamage(amount);
    else if ( mode === "heal" ) await actor.applyDamage(-amount);
    else if ( mode === "temp" ) await actor.applyTempHP(amount);
  }

  /**
   * Activa o quita la inspiración.
   * @this {BHDMobileApp}
   */
  static async #onToggleInspiration() {
    const actor = this.actor;
    if ( !actor ) return;
    await actor.update({ "system.attributes.inspiration": !actor.system.attributes.inspiration });
  }

  /**
   * Usa un arma, hechizo, rasgo o consumible con el flujo normal de dnd5e: ventana de opciones si hace
   * falta (espacio de conjuro, recursos), tarjeta en el chat, gasto de usos, tirada de ataque o daño
   * y área en el mapa. Después muestra la tarjeta en el panel de resultados.
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onUseItem(event, target) {
    const item = this.actor?.items.get(target.dataset.itemId);
    if ( !item || this.#using ) return;
    this.#using = true;
    target.classList.add("bhd-rolling");
    try {
      const result = await item.use({ event });
      const message = result?.message ?? result;
      if ( message instanceof foundry.documents.ChatMessage ) this.#openTray(message);
    } finally {
      this.#using = false;
      target.classList.remove("bhd-rolling");
    }
  }

  /**
   * Muestra la descripción completa de un objeto en una ventana.
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onItemInfo(event, target) {
    const item = this.actor?.items.get(target.dataset.itemId);
    if ( !item ) return;
    const description = await foundry.applications.ux.TextEditor.implementation.enrichHTML(
      item.system.description?.value ?? "",
      { rollData: item.getRollData(), relativeTo: item, secrets: item.isOwner }
    );
    const subtitle = target.closest(".bhd-action")?.querySelector(".bhd-action-sub")?.textContent ?? "";
    const content = document.createElement("div");
    content.className = "bhd-item-info";
    if ( subtitle ) {
      const sub = document.createElement("p");
      sub.className = "bhd-item-info-sub";
      sub.textContent = subtitle;
      content.append(sub);
    }
    content.insertAdjacentHTML("beforeend", description);
    await DialogV2.prompt({
      window: { title: item.name, icon: "fa-solid fa-circle-info" },
      classes: ["bhd-dialog"],
      content: content.outerHTML,
      ok: { label: "BHD.Actions.Close", icon: "fa-solid fa-check" },
      rejectClose: false
    });
  }

  /**
   * Cambia el filtro de la pestaña Acciones (todo, acción, adicional, reacción).
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onActionFilter(event, target) {
    this.#actionFilter = target.dataset.filter;
    for ( const chip of this.element.querySelectorAll("[data-action=actionFilter]") ) {
      const active = chip.dataset.filter === this.#actionFilter;
      chip.classList.toggle("bhd-on", active);
      chip.setAttribute("aria-pressed", String(active));
    }
    this.#applyActionFilters();
  }

  /**
   * Cierra el panel de resultados.
   * @this {BHDMobileApp}
   */
  static #onCloseTray() {
    this.#trayMessages = [];
    this.#trayRender++;
    const tray = this.element.querySelector(".bhd-tray");
    if ( tray ) tray.hidden = true;
  }

  /**
   * Pregunta y, si el jugador confirma, vuelve a la interfaz normal de Foundry en este dispositivo.
   * @this {BHDMobileApp}
   */
  static async #onExitMobile() {
    const confirmed = await DialogV2.confirm({
      window: { title: "BHD.Exit.Title" },
      content: `<p>${game.i18n.localize("BHD.Exit.Content")}</p>`,
      rejectClose: false
    });
    if ( !confirmed ) return;
    await game.settings.set(MODULE_ID, "preferNormal", true);
    window.location.reload();
  }
}
