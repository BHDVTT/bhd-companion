import { MODULE_ID, TEMPLATE_PATH } from "../constants.js";
import { getActiveCharacter, getCharacterChoices, prepareCharacterSheet } from "./character-data.js";
import { ACTION_FILTERS, normalizeSearch, prepareActions } from "./actions-data.js";
import { getActiveCombat, isActorTurn, prepareCombat, prepareDeathSaves } from "./combat-data.js";
import { prepareInventory } from "./inventory-data.js";
import { getSavedNotes, localNotesDraft, NOTES_FLAG, prepareNotes } from "./notes-data.js";
import { applyLargeText, syncPlaylistSounds } from "../mobile-mode.js";
import { canKeepAwake, updateWakeLock } from "../wake-lock.js";
import { getInstallMode, promptInstall } from "../home-screen.js";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

/** Cuánto tiempo (ms) se ve el resultado de una tirada en el teléfono. */
const TOAST_DURATION = 4000;

/** Cuánto hay que mantener el dedo (ms) para abrir el menú de ventaja / desventaja. */
const LONG_PRESS_MS = 450;

/** Cuánto se puede mover el dedo (px) sin que deje de contar como toque largo. */
const LONG_PRESS_TOLERANCE = 10;

/** Cuánto se espera (ms) desde la última tecla para guardar las notas personales. */
const NOTES_SAVE_DELAY = 1000;

/**
 * Actividades que con un toque rápido se usan sin ventana cuando no hay nivel de espacio que elegir.
 * Las demás (invocar, encantar, transformar...) siempre muestran la ventana de dnd5e.
 */
const SIMPLE_ACTIVITY_TYPES = new Set(["attack", "damage", "heal", "save", "check", "utility"]);

/**
 * ¿Este hechizo de nivel solo se puede lanzar con un tipo de espacio, y es el que dnd5e ya eligió?
 * Pasa, por ejemplo, con un brujo que solo tiene espacios de pacto: no hay nada que elegir,
 * así que con un toque se lanza directo al nivel del espacio de pacto.
 * Usa las mismas reglas que la ventana de uso de dnd5e para decidir qué espacios se ofrecen.
 * @param {Activity} activity
 * @param {object} usageConfig  Configuración de uso ya preparada por dnd5e.
 * @returns {boolean}
 */
function hasSingleSlotChoice(activity, usageConfig) {
  if ( !activity.requiresSpellSlot || usageConfig.cause?.activity ) return false;
  const consumeSlot = (usageConfig.consume === true) || usageConfig.consume?.spellSlot;
  if ( !consumeSlot ) return false;
  const actor = activity.actor;
  const item = activity.item;
  const spells = actor.system.spells ?? {};
  const minimumLevel = item.system.level ?? 1;
  const method = CONFIG.DND5E.spellcasting[item.system.method];
  const options = Object.entries(spells).filter(([, slot]) => {
    if ( !slot.max || !slot.type || (slot.level < minimumLevel) ) return false;
    if ( method?.exclusive?.spells && (item.system.method !== slot.type) ) return false;
    const model = CONFIG.DND5E.spellcasting[slot.type];
    if ( model?.exclusive?.slots && (item.system.method !== slot.type) ) return false;
    return true;
  });
  if ( options.length !== 1 ) return false;
  const [key, slot] = options[0];
  return (key === usageConfig.spell?.slot) && (slot.value > 0);
}

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
      closeTray: BHDMobileApp.#onCloseTray,
      chooseUse: BHDMobileApp.#onChooseUse,
      closeChooser: BHDMobileApp.#onCloseChooser,
      endTurn: BHDMobileApp.#onEndTurn,
      dismissTurnAlert: BHDMobileApp.#onDismissTurnAlert,
      bhdEquip: BHDMobileApp.#onEquip,
      bhdAttune: BHDMobileApp.#onAttune,
      bhdQuantity: BHDMobileApp.#onQuantity,
      bhdRest: BHDMobileApp.#onRest,
      bhdSettings: BHDMobileApp.#onOpenSettings,
      bhdCloseSettings: BHDMobileApp.#onCloseSettings,
      bhdToggleSetting: BHDMobileApp.#onToggleSetting,
      bhdInstall: BHDMobileApp.#onInstall
    }
  };

  static PARTS = {
    header: { template: `${TEMPLATE_PATH}/mobile/header.hbs` },
    main: {
      template: `${TEMPLATE_PATH}/mobile/main.hbs`,
      templates: [
        `${TEMPLATE_PATH}/mobile/character.hbs`,
        `${TEMPLATE_PATH}/mobile/actions.hbs`,
        `${TEMPLATE_PATH}/mobile/action-row.hbs`,
        `${TEMPLATE_PATH}/mobile/combat.hbs`,
        `${TEMPLATE_PATH}/mobile/death-saves.hbs`,
        `${TEMPLATE_PATH}/mobile/inventory.hbs`,
        `${TEMPLATE_PATH}/mobile/inventory-row.hbs`,
        `${TEMPLATE_PATH}/mobile/inventory-container.hbs`,
        `${TEMPLATE_PATH}/mobile/notes.hbs`,
        `${TEMPLATE_PATH}/mobile/settings.hbs`
      ],
      scrollable: [""]
    },
    turn: { template: `${TEMPLATE_PATH}/mobile/turn.hbs` },
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
   * Toque largo en curso sobre una fila de la pestaña Acciones.
   * @type {{target: HTMLElement, x: number, y: number, timer: number, fired: boolean}|null}
   */
  #longPress = null;

  /** Objeto que se está usando con un toque rápido (sin ventanas si es sencillo). */
  #quickUseItem = null;

  /**
   * Ventaja / desventaja elegida para el próximo ataque de un objeto.
   * @type {{itemId: string, mode: string, time?: number}|null}
   */
  #pendingAttack = null;

  /** Objeto usado con "Más opciones": sus tiradas muestran las ventanas completas de dnd5e. */
  #fullOptionsItem = null;

  /** Último turno avisado ("combate-ronda-turno"), para no repetir el aviso del mismo turno. */
  #alertedTurn = null;

  /** ¿Se está terminando el turno? Evita pasar dos turnos por tocar dos veces. */
  #endingTurn = false;

  /** Contenedores del inventario que el jugador dejó abiertos (se conservan al redibujar). */
  #openContainers = new Set();

  /** Cambios de inventario en curso, por objeto. Evita que dos toques seguidos se pisen. */
  #itemUpdates = new Set();

  /**
   * Cantidades que el jugador está cambiando con − / + y aún no se guardaron, por objeto.
   * Varios toques seguidos se guardan juntos en un solo cambio.
   * @type {Map<string, {value: number, timer: number}>}
   */
  #pendingQuantities = new Map();

  /** ¿Hay un descanso en curso? Evita abrir dos ventanas de descanso. */
  #resting = false;

  /**
   * Notas personales que el jugador está escribiendo y aún no se guardaron.
   * @type {{actorId: string, text: string}|null}
   */
  #notesDraft = null;

  /** Temporizador del guardado automático de las notas. */
  #notesTimeout;

  /** Posición del cursor en las notas, para recuperarla si la vista se redibuja mientras se escribe. */
  #notesSelection = null;

  /**
   * Personaje que se muestra ahora mismo.
   * @type {Actor|null}
   */
  get actor() {
    return getActiveCharacter();
  }

  /* -------------------------------------------- */

  /**
   * Solo se preparan y dibujan los datos de la pestaña que se ve: en teléfonos viejos, rehacer
   * todas las pestañas (lista de hechizos, inventario, biografía) con cada cambio de vida es lento.
   * Las demás se preparan al tocarlas (ver #onTab).
   * @override
   */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const actor = this.actor;
    const tab = this.tabGroups.primary;
    context.userName = game.user.name;
    context.character = actor ? { name: actor.name, img: actor.img } : null;
    context.sheet = (actor && (tab === "character")) ? prepareCharacterSheet(actor) : null;
    context.hpAmount = this.#hpAmount;
    context.actions = (actor && (tab === "actions")) ? prepareActions(actor) : null;
    context.spellSearch = this.#spellSearch;
    context.actionFilters = ["all", ...ACTION_FILTERS].map(id => ({
      id,
      label: game.i18n.localize(`BHD.Actions.Filter${id.capitalize()}`),
      active: id === this.#actionFilter
    }));
    // El combate se prepara siempre: la barra de pestañas y la barra "Es tu turno" lo usan.
    context.combat = prepareCombat(actor);
    context.deathSaves = prepareDeathSaves(actor);
    context.inventory = (actor && (tab === "inventory")) ? prepareInventory(actor, this.#openContainers) : null;
    const draft = (this.#notesDraft?.actorId === actor?.id) ? this.#notesDraft.text : null;
    context.notes = (actor && (tab === "notes")) ? await prepareNotes(actor, draft) : null;

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

    // Menú del toque largo: ventaja, normal, desventaja o todas las opciones de dnd5e.
    const chooser = document.createElement("div");
    chooser.className = "bhd-chooser";
    chooser.hidden = true;
    this.element.append(chooser);

    // Toque largo en las filas de la pestaña Acciones. Se escucha en el contenedor (que no se
    // vuelve a crear al redibujar), así sirve para todas las filas.
    this.element.addEventListener("pointerdown", this.#onPointerDown.bind(this));
    this.element.addEventListener("pointermove", this.#onPointerMove.bind(this));
    for ( const type of ["pointerup", "pointercancel"] ) {
      this.element.addEventListener(type, () => clearTimeout(this.#longPress?.timer));
    }
    // Android abre un menú del navegador con el toque largo: lo evitamos en las filas.
    this.element.addEventListener("contextmenu", event => {
      if ( event.target.closest(".bhd-action-use") ) event.preventDefault();
    });

    const toast = document.createElement("div");
    toast.className = "bhd-toast";
    toast.setAttribute("role", "status");
    toast.hidden = true;
    this.element.append(toast);

    // Aviso a pantalla completa "¡Es tu turno!". Se toca en cualquier sitio para cerrarlo.
    const alert = document.createElement("div");
    alert.className = "bhd-turn-alert";
    alert.dataset.action = "dismissTurnAlert";
    alert.setAttribute("role", "alertdialog");
    alert.hidden = true;
    this.element.append(alert);

    // Panel de ajustes del teléfono (letra grande, pantalla encendida, música, instalar...).
    const settings = document.createElement("div");
    settings.className = "bhd-settings";
    settings.hidden = true;
    this.element.append(settings);

    // Notas que no se llegaron a guardar antes de una recarga (p. ej. se cayó el Wi-Fi).
    const actor = this.actor;
    const unsaved = actor ? localNotesDraft(actor.id) : null;
    if ( (unsaved !== null) && (unsaved !== getSavedNotes(actor)) ) {
      this.#notesDraft = { actorId: actor.id, text: unsaved };
      this.#saveNotes();
    }
    else if ( actor ) localNotesDraft(actor.id, null);

    // Si al abrir la vista ya es el turno del jugador, también se le avisa.
    this.onCombatUpdate();
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

    // Inventario: monedas editables y contenedores abiertos o cerrados.
    for ( const input of this.element.querySelectorAll("[data-bhd-currency]") ) {
      input.addEventListener("change", this.#onCurrencyChange.bind(this));
      input.addEventListener("focus", () => input.select());
    }
    for ( const [itemId, pending] of this.#pendingQuantities ) this.#showQuantity(itemId, pending.value);
    for ( const details of this.element.querySelectorAll(".bhd-inv-container") ) {
      details.addEventListener("toggle", () => {
        if ( details.open ) this.#openContainers.add(details.dataset.containerId);
        else this.#openContainers.delete(details.dataset.containerId);
      });
    }

    // Notas personales: se guardan solas un momento después de dejar de escribir.
    const notes = this.element.querySelector("[data-bhd-notes]");
    notes?.addEventListener("input", event => {
      const actor = this.actor;
      if ( !actor ) return;
      this.#notesDraft = { actorId: actor.id, text: event.currentTarget.value };
      localNotesDraft(actor.id, this.#notesDraft.text);
      this.#setNotesStatus("BHD.Notes.Unsaved");
      clearTimeout(this.#notesTimeout);
      this.#notesTimeout = setTimeout(() => this.#saveNotes(), NOTES_SAVE_DELAY);
    });
    notes?.addEventListener("change", () => this.#saveNotes());
  }

  /** @override */
  _preSyncPartState(partId, newElement, priorElement, state) {
    super._preSyncPartState(partId, newElement, priorElement, state);
    // Si el jugador está escribiendo sus notas, recordar dónde estaba el cursor.
    const notes = priorElement.querySelector("[data-bhd-notes]");
    if ( notes && (notes === document.activeElement) ) {
      state.bhdNotes = { start: notes.selectionStart, end: notes.selectionEnd, scroll: notes.scrollTop };
    }
  }

  /** @override */
  _syncPartState(partId, newElement, priorElement, state) {
    super._syncPartState(partId, newElement, priorElement, state);
    const notes = state.bhdNotes && newElement.querySelector("[data-bhd-notes]");
    if ( !notes ) return;
    notes.focus();
    notes.setSelectionRange(state.bhdNotes.start, state.bhdNotes.end);
    notes.scrollTop = state.bhdNotes.scroll;
  }

  /* -------------------------------------------- */
  /*  Pestañas Inventario y Notas                 */
  /* -------------------------------------------- */

  /**
   * Guarda una moneda cuando el jugador termina de escribir la cantidad.
   * @param {Event} event
   */
  async #onCurrencyChange(event) {
    const actor = this.actor;
    const input = event.currentTarget;
    const key = input.dataset.bhdCurrency;
    if ( !actor || !(key in (actor.system.currency ?? {})) ) return;
    const value = Math.max(parseInt(input.value) || 0, 0);
    input.value = value;
    if ( value !== actor.system.currency[key] ) await actor.update({ [`system.currency.${key}`]: value });
  }

  /**
   * Guarda en el personaje las notas personales pendientes.
   */
  async #saveNotes() {
    clearTimeout(this.#notesTimeout);
    const draft = this.#notesDraft;
    const actor = game.actors.get(draft?.actorId);
    if ( !actor ) return;
    try {
      if ( draft.text !== getSavedNotes(actor) ) await actor.setFlag(MODULE_ID, NOTES_FLAG, draft.text);
      // Si siguió escribiendo mientras se guardaba, queda pendiente lo nuevo.
      if ( this.#notesDraft === draft ) {
        this.#notesDraft = null;
        localNotesDraft(actor.id, null);
        this.#setNotesStatus("BHD.Notes.Saved");
      }
    } catch(err) {
      console.error("BHD Companion | No se pudieron guardar las notas", err);
      this.#setNotesStatus("BHD.Notes.SaveFailed");
    }
  }

  /**
   * Texto pequeño bajo las notas: "Guardado", "Sin guardar"...
   * @param {string} key
   */
  #setNotesStatus(key) {
    const status = this.element?.querySelector("[data-bhd-notes-status]");
    if ( status ) status.textContent = game.i18n.localize(key);
  }

  /**
   * Hace un cambio en un objeto del inventario, sin dejar que dos toques seguidos en el mismo
   * objeto se pisen (el segundo se ignora hasta que termine el primero).
   * @param {Item} item
   * @param {object} changes
   */
  async #updateItem(item, changes) {
    if ( this.#itemUpdates.has(item.id) ) return;
    this.#itemUpdates.add(item.id);
    try {
      await item.update(changes);
    } finally {
      this.#itemUpdates.delete(item.id);
    }
  }

  /**
   * Muestra una cantidad en la fila de un objeto sin esperar a que se guarde.
   * @param {string} itemId
   * @param {number} value
   */
  #showQuantity(itemId, value) {
    for ( const button of this.element.querySelectorAll(`[data-action="bhdQuantity"][data-item-id="${itemId}"]`) ) {
      const group = button.closest(".bhd-inv-qty");
      group.querySelector(".bhd-inv-qty-value").textContent = value;
      if ( button.dataset.step === "-1" ) button.disabled = value <= 0;
    }
  }

  /**
   * Guarda la cantidad pendiente de un objeto.
   * @param {string} itemId
   */
  async #commitQuantity(itemId) {
    const pending = this.#pendingQuantities.get(itemId);
    this.#pendingQuantities.delete(itemId);
    const item = this.actor?.items.get(itemId);
    if ( !pending || !item || (pending.value === item.system.quantity) ) return;
    await item.update({ "system.quantity": pending.value });
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
  /*  Toque rápido y toque largo                  */
  /* -------------------------------------------- */

  /**
   * Empieza a contar un posible toque largo sobre una fila de la pestaña Acciones.
   * @param {PointerEvent} event
   */
  #onPointerDown(event) {
    clearTimeout(this.#longPress?.timer);
    this.#longPress = null;
    const target = event.target.closest(".bhd-action-use");
    if ( !target || (event.button !== 0) ) return;
    const press = this.#longPress = { target, x: event.clientX, y: event.clientY, fired: false };
    press.timer = setTimeout(() => {
      press.fired = true;
      navigator.vibrate?.(20);
      this.#openChooser(target.dataset.itemId);
    }, LONG_PRESS_MS);
  }

  /**
   * Si el dedo se mueve (el jugador está desplazando la lista), no es un toque largo.
   * @param {PointerEvent} event
   */
  #onPointerMove(event) {
    const press = this.#longPress;
    if ( !press || press.fired ) return;
    if ( Math.hypot(event.clientX - press.x, event.clientY - press.y) > LONG_PRESS_TOLERANCE ) {
      clearTimeout(press.timer);
      this.#longPress = null;
    }
  }

  /**
   * Muestra el menú del toque largo para un objeto.
   * @param {string} itemId
   */
  #openChooser(itemId) {
    const item = this.actor?.items.get(itemId);
    const chooser = this.element.querySelector(".bhd-chooser");
    if ( !item || !chooser ) return;
    const hasAttack = !!item.system.activities?.getByType("attack").length;
    const button = (mode, icon, label, cssClass) => `
      <button type="button" class="${cssClass}" data-action="chooseUse" data-mode="${mode}" data-item-id="${item.id}">
        <i class="${icon}" aria-hidden="true"></i><span>${game.i18n.localize(label)}</span>
      </button>`;
    chooser.innerHTML = `
      <div class="bhd-chooser-backdrop" data-action="closeChooser"></div>
      <section class="bhd-chooser-sheet" role="dialog" aria-modal="true">
        <header class="bhd-chooser-header"><img src="" alt=""><span class="bhd-chooser-name"></span></header>
        ${hasAttack ? `<div class="bhd-chooser-modes">
          ${button("advantage", "fa-solid fa-angles-up", "BHD.Actions.Advantage", "bhd-mode bhd-mode-adv")}
          ${button("normal", "fa-solid fa-dice-d20", "BHD.Actions.Normal", "bhd-mode")}
          ${button("disadvantage", "fa-solid fa-angles-down", "BHD.Actions.Disadvantage", "bhd-mode bhd-mode-dis")}
        </div>` : button("normal", "fa-solid fa-hand-sparkles", "BHD.Actions.Use", "bhd-mode bhd-mode-use")}
        ${button("full", "fa-solid fa-sliders", "BHD.Actions.MoreOptions", "bhd-chooser-more")}
        <button type="button" class="bhd-chooser-cancel" data-action="closeChooser">${game.i18n.localize("BHD.Actions.Cancel")}</button>
      </section>`;
    chooser.querySelector(".bhd-chooser-header img").src = item.img;
    chooser.querySelector(".bhd-chooser-name").textContent = item.name;
    chooser.hidden = false;
  }

  /** Cierra el menú del toque largo. */
  #closeChooser() {
    const chooser = this.element.querySelector(".bhd-chooser");
    if ( chooser ) chooser.hidden = true;
  }

  /**
   * Usa un objeto con el flujo de dnd5e.
   * @param {Item} item
   * @param {"normal"|"advantage"|"disadvantage"|"full"} mode  "full" muestra todas las ventanas de dnd5e;
   *   los demás saltan las ventanas cuando el uso es sencillo y tiran directo.
   * @param {PointerEvent} event
   * @param {HTMLElement} [target]  Fila tocada, para marcarla mientras se usa.
   */
  async #useItem(item, mode, event, target) {
    if ( this.#using ) return;
    const quick = mode !== "full";
    this.#using = true;
    this.#quickUseItem = quick ? item.id : null;
    this.#fullOptionsItem = quick ? null : item.id;
    this.#pendingAttack = quick ? { itemId: item.id, mode } : null;
    target?.classList.add("bhd-rolling");
    try {
      const result = await item.use({ event });
      const message = result?.message ?? result;
      if ( message instanceof foundry.documents.ChatMessage ) this.#openTray(message);
    } finally {
      this.#using = false;
      this.#quickUseItem = null;
      // El ataque automático llega justo después del uso; pasado un momento ya no se aplica.
      if ( this.#pendingAttack ) this.#pendingAttack.time = Date.now();
      target?.classList.remove("bhd-rolling");
    }
  }

  /**
   * Hook `dnd5e.preUseActivity`: con un toque rápido, salta la ventana de uso si no hay nada
   * importante que elegir (trucos, armas, pociones...). Con hechizos de nivel la ventana sigue
   * apareciendo para elegir el espacio de conjuro.
   * @param {Activity} activity
   * @param {object} usageConfig
   * @param {object} dialogConfig
   */
  onPreUseActivity(activity, usageConfig, dialogConfig) {
    if ( (activity.actor !== this.actor) || (activity.item.id !== this.#quickUseItem) ) return;
    const simple = SIMPLE_ACTIVITY_TYPES.has(activity.type)
      && ((usageConfig.scaling === false) || hasSingleSlotChoice(activity, usageConfig))
      && !usageConfig.concentration?.end;          // no hay que terminar otra concentración
    if ( simple ) dialogConfig.configure = false;
  }

  /**
   * Hooks `dnd5e.preRollAttackV2` / `dnd5e.preRollDamageV2`: en el teléfono los ataques y daños
   * de este personaje se tiran sin ventana, con la ventaja / desventaja elegida con el toque largo.
   * Si el jugador eligió "Más opciones", se deja la ventana normal de dnd5e.
   * @param {"attack"|"damage"} type
   * @param {object} config  Configuración de la tirada (config.subject es la actividad).
   * @param {object} dialog  Configuración de la ventana.
   */
  onPreRoll(type, config, dialog) {
    const activity = config.subject;
    if ( !activity || (activity.actor !== this.actor) ) return;
    if ( activity.item.id === this.#fullOptionsItem ) return;
    dialog.configure = false;
    if ( type !== "attack" ) return;
    const pending = this.#pendingAttack;
    this.#pendingAttack = null;
    const fresh = pending && (pending.itemId === activity.item.id) && (!pending.time || (Date.now() - pending.time < 3000));
    if ( !fresh ) return;
    if ( pending.mode === "advantage" ) config.advantage = true;
    else if ( pending.mode === "disadvantage" ) config.disadvantage = true;
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
  /*  Pestaña Combate                             */
  /* -------------------------------------------- */

  /**
   * Llamado cuando cambia un combate (turno, ronda, inicio, fin): si ahora le toca al personaje
   * del jugador, muestra el aviso a pantalla completa y hace vibrar el teléfono.
   */
  onCombatUpdate() {
    const combat = getActiveCombat();
    const actor = this.actor;
    if ( !isActorTurn(combat, actor) ) {
      this.#hideTurnAlert();
      return;
    }
    const key = `${combat.id}-${combat.round}-${combat.turn}`;
    if ( key === this.#alertedTurn ) return;
    this.#alertedTurn = key;
    this.#showTurnAlert(combat, actor);
  }

  /**
   * Muestra el aviso "¡Es tu turno!".
   * @param {Combat} combat
   * @param {Actor} actor
   */
  #showTurnAlert(combat, actor) {
    const alert = this.element?.querySelector(".bhd-turn-alert");
    if ( !alert ) return;
    const atZero = !!prepareDeathSaves(actor)?.canRoll;
    const localize = key => game.i18n.localize(key);
    alert.innerHTML = `
      <div class="bhd-turn-alert-box">
        <img class="bhd-turn-alert-img" src="" alt="">
        <span class="bhd-turn-alert-round">${game.i18n.format("BHD.Combat.Round", { round: combat.round })}</span>
        <strong class="bhd-turn-alert-title">${localize("BHD.Combat.YourTurnAlert")}</strong>
        <span class="bhd-turn-alert-hint">${localize(atZero ? "BHD.Combat.YourTurnDying" : "BHD.Combat.YourTurnHint")}</span>
        <button type="button" class="bhd-big-btn" data-action="dismissTurnAlert">${localize("BHD.Combat.LetsGo")}</button>
      </div>`;
    alert.querySelector(".bhd-turn-alert-img").src = combat.combatant?.img || actor.img;
    alert.hidden = false;
    // Vibración: funciona en Android; los iPhone no lo permiten y simplemente no vibran.
    // Chrome la bloquea (con un aviso en la consola) si aún no se tocó la pantalla.
    const touched = navigator.userActivation?.hasBeenActive ?? true;
    try {
      if ( touched ) navigator.vibrate?.([300, 150, 300, 150, 500]);
    } catch(err) {}
  }

  /** Cierra el aviso "¡Es tu turno!" (por ejemplo, si el turno pasó a otro). */
  #hideTurnAlert() {
    const alert = this.element?.querySelector(".bhd-turn-alert");
    if ( alert ) alert.hidden = true;
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
    const combat = getActiveCombat();
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
  static async #onTab(event, target) {
    const { tab, group } = target.dataset;
    const main = this.parts?.main;
    // Tocar la pestaña en la que ya estás sube al principio, como en las apps del teléfono.
    if ( this.tabGroups[group] === tab ) {
      main?.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    // Solo la pestaña visible tiene contenido (ver _prepareContext): hay que dibujar la nueva.
    this.tabGroups[group] = tab;
    await this.render({ parts: ["main", "nav"] });
    if ( this.parts?.main ) this.parts.main.scrollTop = 0;
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
        case "death": rolls = await actor.rollDeathSave({ event }, dialog); break;
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
   * Toque en una fila: usa el arma, hechizo, rasgo o consumible con el flujo normal de dnd5e
   * (tarjeta en el chat, gasto de usos o espacio, tirada de ataque o daño, área en el mapa).
   * Si el uso es sencillo, tira directo sin ventanas. Después muestra la tarjeta en el panel.
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onUseItem(event, target) {
    // Al soltar un toque largo también llega un clic: ese ya abrió el menú, no se usa el objeto.
    if ( this.#longPress?.fired && (this.#longPress.target === target) ) {
      this.#longPress = null;
      return;
    }
    const item = this.actor?.items.get(target.dataset.itemId);
    if ( item ) await this.#useItem(item, "normal", event, target);
  }

  /**
   * Botón del menú del toque largo: Ventaja, Normal, Desventaja, Usar o Más opciones.
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onChooseUse(event, target) {
    this.#closeChooser();
    const item = this.actor?.items.get(target.dataset.itemId);
    if ( item ) await this.#useItem(item, target.dataset.mode, event);
  }

  /**
   * Cierra el menú del toque largo sin usar nada.
   * @this {BHDMobileApp}
   */
  static #onCloseChooser() {
    this.#closeChooser();
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
    // Los objetos sin identificar muestran a los jugadores solo su descripción "sin identificar".
    const unidentified = (item.system.identified === false) && !game.user.isGM;
    const html = unidentified ? item.system.unidentified?.description : item.system.description?.value;
    const description = await foundry.applications.ux.TextEditor.implementation.enrichHTML(
      html ?? "",
      { rollData: item.getRollData(), relativeTo: item, secrets: item.isOwner }
    );
    const row = target.closest(".bhd-action, .bhd-inv-item");
    const subtitle = row?.querySelector(".bhd-action-sub")?.textContent.trim() ?? "";
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
   * Termina el turno del jugador y pasa al siguiente combatiente (como el botón del registro
   * de combate de Foundry). Solo se puede si el turno actual es del personaje del jugador.
   * @this {BHDMobileApp}
   */
  static async #onEndTurn() {
    const combat = getActiveCombat();
    if ( this.#endingTurn || !isActorTurn(combat, this.actor) || !combat.combatant.isOwner ) return;
    this.#endingTurn = true;
    this.#hideTurnAlert();
    try {
      await combat.nextTurn();
    } finally {
      this.#endingTurn = false;
    }
  }

  /**
   * Cierra el aviso "¡Es tu turno!".
   * @this {BHDMobileApp}
   */
  static #onDismissTurnAlert() {
    this.#hideTurnAlert();
  }

  /**
   * Equipa o desequipa un objeto del inventario.
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onEquip(event, target) {
    const item = this.actor?.items.get(target.dataset.itemId);
    if ( !item || !("equipped" in item.system) ) return;
    await this.#updateItem(item, { "system.equipped": !item.system.equipped });
  }

  /**
   * Sintoniza o deja de sintonizar un objeto mágico. No deja pasar del máximo del personaje.
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onAttune(event, target) {
    const actor = this.actor;
    const item = actor?.items.get(target.dataset.itemId);
    if ( !item?.system.canAttune ) return;
    const attuned = !item.system.attuned;
    const attunement = actor.system.attributes?.attunement;
    if ( attuned && attunement && (attunement.value >= attunement.max) ) {
      ui.notifications.warn(game.i18n.format("BHD.Inventory.AttunementFull", { max: attunement.max }));
      return;
    }
    await this.#updateItem(item, { "system.attuned": attuned });
  }

  /**
   * Botones − / + de la cantidad de un objeto. El número cambia al momento y se guarda
   * un instante después del último toque.
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onQuantity(event, target) {
    const itemId = target.dataset.itemId;
    const item = this.actor?.items.get(itemId);
    if ( !item ) return;
    const pending = this.#pendingQuantities.get(itemId);
    clearTimeout(pending?.timer);
    const current = pending?.value ?? item.system.quantity ?? 0;
    const value = Math.max(current + Number(target.dataset.step), 0);
    const timer = setTimeout(() => this.#commitQuantity(itemId), 400);
    this.#pendingQuantities.set(itemId, { value, timer });
    this.#showQuantity(itemId, value);
  }

  /**
   * Descanso corto o largo con el flujo de dnd5e: su ventana explica lo que se recupera y pide
   * confirmar (en el corto, además, permite gastar dados de golpe). Si se cancela, no pasa nada.
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onRest(event, target) {
    const actor = this.actor;
    if ( !actor || this.#resting ) return;
    const long = target.dataset.type === "long";
    this.#resting = true;
    try {
      const result = await (long ? actor.longRest() : actor.shortRest());
      if ( !result ) return;
      const healed = result.deltas?.hitPoints ?? result.dhp ?? 0;
      const label = game.i18n.localize(long ? "BHD.Rest.LongDone" : "BHD.Rest.ShortDone");
      const total = healed > 0 ? game.i18n.format("BHD.Rest.Healed", { hp: healed }) : "✓";
      this.#showRollResult(label, { total });
    } finally {
      this.#resting = false;
    }
  }

  /* -------------------------------------------- */
  /*  Ajustes del teléfono                        */
  /* -------------------------------------------- */

  /**
   * Dibuja el panel de ajustes con el estado actual de cada opción.
   */
  async #renderSettings() {
    const panel = this.element.querySelector(".bhd-settings");
    if ( !panel ) return;
    const get = key => game.settings.get(MODULE_ID, key);
    panel.innerHTML = await foundry.applications.handlebars.renderTemplate(`${TEMPLATE_PATH}/mobile/settings.hbs`, {
      toggles: [
        { key: "largeText", icon: "fa-solid fa-text-height", on: get("largeText") },
        { key: "keepAwake", icon: "fa-solid fa-sun", on: get("keepAwake"), unsupported: !canKeepAwake() },
        { key: "phoneMusic", icon: "fa-solid fa-music", on: get("phoneMusic") }
      ],
      install: getInstallMode()
    });
  }

  /**
   * Abre el panel de ajustes (botón del engranaje del encabezado).
   * @this {BHDMobileApp}
   */
  static async #onOpenSettings() {
    await this.#renderSettings();
    const panel = this.element.querySelector(".bhd-settings");
    if ( panel ) panel.hidden = false;
  }

  /**
   * Cierra el panel de ajustes.
   * @this {BHDMobileApp}
   */
  static #onCloseSettings() {
    const panel = this.element.querySelector(".bhd-settings");
    if ( panel ) panel.hidden = true;
  }

  /**
   * Activa o desactiva una opción del teléfono y la aplica al momento, sin recargar.
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onToggleSetting(event, target) {
    const key = target.dataset.setting;
    if ( !["largeText", "keepAwake", "phoneMusic"].includes(key) ) return;
    await game.settings.set(MODULE_ID, key, !game.settings.get(MODULE_ID, key));
    if ( key === "largeText" ) applyLargeText();
    else if ( key === "keepAwake" ) updateWakeLock();
    else if ( key === "phoneMusic" ) syncPlaylistSounds();
    await this.#renderSettings();
  }

  /**
   * Botón "Instalar" (Chrome / Android): muestra el aviso del navegador para añadir la app.
   * @this {BHDMobileApp}
   */
  static async #onInstall() {
    await promptInstall();
    await this.#renderSettings();
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
