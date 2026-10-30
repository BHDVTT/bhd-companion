import { MODULE_ID, TEMPLATE_PATH } from "../constants.js";
import { getActiveCharacter, getCharacterChoices, prepareCharacterSheet } from "./character-data.js";
import { ACTION_FILTERS, normalizeSearch, prepareActions } from "./actions-data.js";
import { getActiveCombat, isActorTurn, prepareCombat, prepareDeathSaves } from "./combat-data.js";
import { BASIC_ACTIONS, getTargetNeed, prepareHud, prepareTargetCards, prepareTargetChips } from "./combat-hud-data.js";
import { ECONOMY_BLOCKS, getEconomy, getOwnCombatant, setEconomy } from "../economy.js";
import { setTargets, toggleTarget } from "../targets.js";
import { prepareInventory } from "./inventory-data.js";
import { getMoveToken, prepareMovement } from "./move-data.js";
import { requestMovement } from "../movement.js";
import { getSavedNotes, localNotesDraft, NOTES_FLAG, prepareNotes } from "./notes-data.js";
import { applyLargeText, syncPlaylistSounds } from "../mobile-mode.js";
import { canKeepAwake, updateWakeLock } from "../wake-lock.js";
import { getInstallMode, promptInstall } from "../home-screen.js";
import { reloadWithoutUrlMode } from "../device.js";
import { useError, useLog } from "../use-log.js";
import { getScaledActivity, getScaling, getTurnKey, needsCast, needsUsageDialog, QuickActionState } from "../quick-actions.js";
import { getConditionInfo, prepareStatus } from "./status-data.js";
import { findSavePrompts, getSavePromptLabel, rollSavePrompt } from "../save-prompts.js";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

/** Cuánto tiempo (ms) se ve el resultado de una tirada en el teléfono. */
const TOAST_DURATION = 4000;

/** Cuánto hay que mantener el dedo (ms) en Ataque o Daño para abrir el menú (ventaja / crítico). */
const LONG_PRESS_MS = 450;

/** Cuánto se puede mover el dedo (px) sin que deje de contar como toque largo. */
const LONG_PRESS_TOLERANCE = 10;

/** Cuánto se espera (ms) desde la última tecla para guardar las notas personales. */
const NOTES_SAVE_DELAY = 1000;

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
      bhdQuick: BHDMobileApp.#onQuick,
      bhdEndCast: BHDMobileApp.#onEndCast,
      bhdEndConcentration: BHDMobileApp.#onEndConcentration,
      bhdConditionInfo: BHDMobileApp.#onConditionInfo,
      bhdEffectInfo: BHDMobileApp.#onEffectInfo,
      bhdSaveRoll: BHDMobileApp.#onSaveRoll,
      bhdSaveDismiss: BHDMobileApp.#onSaveDismiss,
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
      bhdInstall: BHDMobileApp.#onInstall,
      bhdMove: BHDMobileApp.#onMove,
      bhdMoveUndo: BHDMobileApp.#onMoveUndo,
      bhdMoveReset: BHDMobileApp.#onMoveReset,
      bhdHudBlock: BHDMobileApp.#onHudBlock,
      bhdHudBasic: BHDMobileApp.#onHudBasic,
      bhdHudMark: BHDMobileApp.#onHudMark,
      bhdHudCloseResult: BHDMobileApp.#onHudCloseResult,
      bhdTarget: BHDMobileApp.#onTarget,
      bhdPickTargets: BHDMobileApp.#onPickTargets,
      bhdClearTargets: BHDMobileApp.#onClearTargets,
      bhdPickToggle: BHDMobileApp.#onPickToggle,
      bhdPickConfirm: BHDMobileApp.#onPickConfirm,
      bhdPickNone: BHDMobileApp.#onPickNone,
      bhdPickCancel: BHDMobileApp.#onPickCancel
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
        `${TEMPLATE_PATH}/mobile/status.hbs`,
        `${TEMPLATE_PATH}/mobile/move.hbs`,
        `${TEMPLATE_PATH}/mobile/inventory.hbs`,
        `${TEMPLATE_PATH}/mobile/inventory-row.hbs`,
        `${TEMPLATE_PATH}/mobile/inventory-container.hbs`,
        `${TEMPLATE_PATH}/mobile/notes.hbs`,
        `${TEMPLATE_PATH}/mobile/settings.hbs`,
        `${TEMPLATE_PATH}/mobile/target-picker.hbs`
      ],
      // La fila de retratos del combate conserva su desplazamiento lateral al redibujar.
      scrollable: ["", ".bhd-hud-strip"]
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
        { id: "move", icon: "fa-solid fa-arrows-up-down-left-right" },
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

  /** Botones de tirada: nivel de espacio elegido, lanzamientos en curso y último ataque (crítico). */
  #quick = new QuickActionState();

  /** Objeto cuyas tarjetas y tiradas se ven en el panel de resultados. */
  #trayItemId = null;

  /**
   * Salvaciones pendientes que pide el chat (la primera se ve en el aviso).
   * @type {import("../save-prompts.js").SavePrompt[]}
   */
  #savePrompts = [];

  /** Salvaciones ya avisadas (no se repiten si el mensaje se vuelve a crear o actualizar). */
  #seenPrompts = new Set();

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

  /** Ficha elegida en el selector de la pestaña Mover (si el jugador controla varias). */
  #moveTokenId = null;

  /** Pasos tocados que esperan su turno: se mandan al DM de uno en uno. */
  #moveQueue = Promise.resolve();

  /** Cuántos pasos hay en cola (los toques de más se ignoran para no acumular). */
  #moveQueued = 0;

  /** Sube cada vez que un paso falla: los pasos que ya estaban en cola se descartan. */
  #moveGeneration = 0;

  /** Bloque del HUD de combate abierto: "action", "bonus", "reaction" o null. */
  #hudBlock = null;

  /** ¿Hay que desplazar la vista hasta los bloques del HUD en el próximo dibujo? */
  #scrollToHud = false;

  /**
   * Resultado del último uso desde el HUD: nombre, ataque, impactó o falló, daño.
   * @type {object|null}
   */
  #hudResult = null;

  /**
   * Selector de objetivos abierto.
   * @type {{resolve: Function, max: number, multi: boolean, selected: Set<string>}|null}
   */
  #picker = null;

  /** Turno en el que se centró la fila de retratos (se vuelve a centrar cuando cambia). */
  #stripTurn = null;

  /** ¿Ya se revisó el combate una vez? (para no quitar Esquivar al recargar la página) */
  #combatChecked = false;

  /** Pestaña visible ahora mismo. */
  get activeTab() {
    return this.tabGroups.primary;
  }

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
    context.actions = (actor && (tab === "actions")) ? prepareActions(actor, this.#quick) : null;
    context.spellSearch = this.#spellSearch;
    context.actionFilters = ["all", ...ACTION_FILTERS].map(id => ({
      id,
      label: game.i18n.localize(`BHD.Actions.Filter${id.capitalize()}`),
      active: id === this.#actionFilter
    }));
    // El combate se prepara siempre: la barra de pestañas y la barra "Es tu turno" lo usan.
    context.combat = prepareCombat(actor);
    context.deathSaves = prepareDeathSaves(actor);
    context.status = ["character", "combat"].includes(tab) ? prepareStatus(actor) : null;
    context.hud = (actor && (tab === "combat")) ? prepareHud(actor, this.#hudBlock, this.#quick) : null;
    context.hudResult = (tab === "combat") ? this.#hudResult : null;
    context.move = (tab === "move") ? prepareMovement(actor, this.#moveTokenId) : null;
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

    // Menú del toque largo: ventaja / desventaja (Ataque) o normal / crítico (Daño).
    const chooser = document.createElement("div");
    chooser.className = "bhd-chooser";
    chooser.hidden = true;
    this.element.append(chooser);

    // Toque largo en los botones Ataque y Daño. Se escucha en el contenedor (que no se
    // vuelve a crear al redibujar), así sirve para todas las filas.
    this.element.addEventListener("pointerdown", this.#onPointerDown.bind(this));
    this.element.addEventListener("pointermove", this.#onPointerMove.bind(this));
    for ( const type of ["pointerup", "pointercancel"] ) {
      this.element.addEventListener(type, () => clearTimeout(this.#longPress?.timer));
    }
    // Android abre un menú del navegador con el toque largo: lo evitamos en las filas.
    this.element.addEventListener("contextmenu", event => {
      if ( event.target.closest(".bhd-roll-btn") ) event.preventDefault();
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

    // Aviso de salvación pendiente (hechizo del DM, concentración al recibir daño...).
    const saveAlert = document.createElement("div");
    saveAlert.className = "bhd-save-alert";
    saveAlert.setAttribute("role", "alertdialog");
    saveAlert.hidden = true;
    this.element.append(saveAlert);

    // Panel de ajustes del teléfono (letra grande, pantalla encendida, música, instalar...).
    const settings = document.createElement("div");
    settings.className = "bhd-settings";
    settings.hidden = true;
    this.element.append(settings);

    // Selector de objetivos del HUD de combate.
    const picker = document.createElement("div");
    picker.className = "bhd-picker";
    picker.hidden = true;
    this.element.append(picker);

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
    const moveSelect = this.element.querySelector("[data-bhd-move-token]");
    moveSelect?.addEventListener("change", event => {
      this.#moveTokenId = event.currentTarget.value;
      this.render({ parts: ["main"] });
    });
    const search = this.element.querySelector("[data-bhd-spell-search]");
    search?.addEventListener("input", event => {
      this.#spellSearch = event.currentTarget.value;
      this.#applyActionFilters();
    });
    this.#applyActionFilters();

    // Nivel de espacio de los hechizos: cambia la fórmula de daño de la fila.
    for ( const select of this.element.querySelectorAll("[data-bhd-slot]") ) {
      select.addEventListener("change", event => {
        this.#quick.slots.set(select.dataset.itemId, event.currentTarget.value);
        this.render({ parts: ["main"] });
      });
    }

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

    this.#syncCombatHud(context);
  }

  /**
   * Pestaña Combate tras dibujar: centra la fila de retratos en quien va ahora (solo cuando cambia
   * el turno o la fila es nueva, para no mover la fila mientras el jugador la desplaza) y, si se
   * acaba de abrir un bloque, desplaza la vista para que se vean los bloques y sus opciones.
   * @param {object} context
   */
  #syncCombatHud(context) {
    const strip = this.element.querySelector("[data-bhd-strip]");
    const current = strip?.querySelector(".bhd-current");
    const turnKey = context.combat ? `${context.combat.id}.${context.combat.round}.${context.combat.current?.id}` : null;
    if ( current && ((turnKey !== this.#stripTurn) || (strip.scrollLeft === 0)) ) {
      strip.scrollLeft = current.offsetLeft - ((strip.clientWidth - current.offsetWidth) / 2);
    }
    this.#stripTurn = turnKey;

    if ( this.#scrollToHud ) {
      this.#scrollToHud = false;
      this.element.querySelector(".bhd-hud-blocks")?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
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
  /*  Botones de tirada (toque y toque largo)     */
  /* -------------------------------------------- */

  /**
   * Empieza a contar un posible toque largo sobre un botón Ataque o Daño.
   * @param {PointerEvent} event
   */
  #onPointerDown(event) {
    clearTimeout(this.#longPress?.timer);
    this.#longPress = null;
    const target = event.target.closest('.bhd-roll-btn[data-kind="attack"], .bhd-roll-btn[data-kind="damage"]');
    if ( !target || (event.button !== 0) ) return;
    const press = this.#longPress = { target, x: event.clientX, y: event.clientY, fired: false };
    press.timer = setTimeout(() => {
      press.fired = true;
      navigator.vibrate?.(20);
      this.#openChooser(target);
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
   * Menú del toque largo: en Ataque, ventaja / normal / desventaja (y las ventanas de dnd5e para
   * opciones raras, como la munición o el modo de ataque); en Daño, normal o crítico.
   * @param {HTMLElement} button  Botón tocado (con data-kind, data-item-id, data-activity-id).
   */
  #openChooser(button) {
    const { kind, itemId, activityId, hudBlock } = button.dataset;
    const item = this.actor?.items.get(itemId);
    const chooser = this.element.querySelector(".bhd-chooser");
    if ( !item || !chooser ) return;
    const data = `data-kind="${kind}" data-item-id="${itemId}" data-activity-id="${activityId}"`
      + (hudBlock ? ` data-hud-block="${hudBlock}"` : "");
    const option = (mode, icon, label, cssClass) => `
      <button type="button" class="${cssClass}" data-action="chooseUse" data-mode="${mode}" ${data}>
        <i class="${icon}" aria-hidden="true"></i><span>${game.i18n.localize(label)}</span>
      </button>`;
    const modes = (kind === "attack") ? `
        ${option("advantage", "fa-solid fa-angles-up", "BHD.Actions.Advantage", "bhd-mode bhd-mode-adv")}
        ${option("normal", "fa-solid fa-dice-d20", "BHD.Actions.Normal", "bhd-mode")}
        ${option("disadvantage", "fa-solid fa-angles-down", "BHD.Actions.Disadvantage", "bhd-mode bhd-mode-dis")}` : `
        ${option("normal", "fa-solid fa-droplet", "BHD.Actions.NormalDamage", "bhd-mode")}
        ${option("critical", "fa-solid fa-burst", "BHD.Actions.CriticalDamage", "bhd-mode bhd-mode-crit")}`;
    chooser.innerHTML = `
      <div class="bhd-chooser-backdrop" data-action="closeChooser"></div>
      <section class="bhd-chooser-sheet" role="dialog" aria-modal="true">
        <header class="bhd-chooser-header"><img src="" alt=""><span class="bhd-chooser-name"></span></header>
        <div class="bhd-chooser-modes">${modes}</div>
        ${(kind === "attack") ? option("full", "fa-solid fa-sliders", "BHD.Actions.MoreOptions", "bhd-chooser-more") : ""}
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
   * Un botón de tirada: Ataque, Daño, Salvación, Curar o Usar. Sin ventanas de dnd5e: todo se elige
   * en la fila (nivel del hechizo) o con el toque largo (ventaja, crítico), con los objetivos marcados.
   * Si el objeto gasta algo (espacio, usos, cantidad) y aún no se "lanzó", primero se lanza
   * (`activity.use`, una sola vez); después, solo la tirada de ese botón.
   * @param {"attack"|"damage"|"save"|"heal"|"use"} kind
   * @param {Item} item
   * @param {Activity|null} activity  Null en objetos sin actividades (botón Usar).
   * @param {object} [options]
   * @param {string} [options.mode="auto"]  "advantage" / "disadvantage" (ataque), "normal" / "critical" (daño).
   * @param {Event} [options.event]
   * @param {HTMLElement} [options.button]  Botón tocado, para marcarlo mientras se tira.
   * @param {string} [options.hudBlock]     Bloque del HUD de combate (pasa por el selector de objetivos).
   */
  async #runQuick(kind, item, activity, { mode="auto", event, button, hudBlock }={}) {
    if ( !this.actor || (item.actor !== this.actor) ) return;
    if ( this.#using ) {
      ui.notifications.info(game.i18n.format("BHD.Use.Busy", { name: item.name }));
      return;
    }
    this.#fullOptionsItem = null;

    // HUD de combate: primero a quién (el daño usa los objetivos que ya se eligieron).
    if ( hudBlock && activity && (kind !== "damage") ) {
      const need = getTargetNeed([activity]);
      if ( need ) {
        const ids = await this.#pickTargets({ title: item.name, img: item.img, max: need.max });
        if ( ids === null ) return;
        setTargets(ids);
      }
    }

    const tag = `${item.name} (${kind})`;
    const block = (hudBlock === "opportunity") ? "reaction" : (hudBlock ?? activity?.activation?.type);
    this.#using = true;
    button?.classList.add("bhd-rolling");
    this.#prepareTray(item);
    try {
      useLog(`${tag} | Toque`, { mode, targets: Array.from(game.user.targets).map(t => t.name) });

      // Objeto sin actividades (p. ej. un consumible sencillo): el uso normal de dnd5e.
      if ( !activity ) {
        const message = await item.use({ event }, { configure: false });
        if ( message instanceof foundry.documents.ChatMessage ) this.#openTray(message);
        this.#markUsed(block);
        return;
      }

      // Como desde la hoja normal: primero `activity.use` (tarjeta del chat, gasto, eventos que escuchan
      // Automated Animations y otros módulos) y después la tirada ligada a esa tarjeta. Un hechizo que gasta
      // espacio se lanza una vez (sus ataques siguientes cuelgan de la misma tarjeta); lo demás (armas,
      // trucos, rasgos, pociones) se vuelve a usar en cada Ataque, Salvación, Curar o Usar. El Daño usa la
      // tarjeta del último uso (o usa la actividad si aún no hay ninguna, p. ej. Proyectil mágico).
      let cast = this.#quick.getCast(item);
      if ( cast?.sticky && ((kind === "save") || (kind === "use")) ) {
        ui.notifications.info(game.i18n.format("BHD.Actions.AlreadyCast", { name: item.name }));
        const message = game.messages.get(cast.messageId);
        if ( message ) this.#openTray(message);
        return;
      }
      if ( !cast || (!cast.sticky && (kind !== "damage")) ) {
        cast = await this.#cast(item, activity, event, tag);
        if ( !cast ) return;
      }

      // Las tiradas de un lanzamiento cuelgan de su tarjeta y usan el nivel del espacio gastado.
      const rollActivity = getScaledActivity(activity, cast?.scaling ?? 0);
      const message = cast?.messageId ? { data: { "flags.dnd5e.originatingMessage": cast.messageId } } : {};
      const dialog = { configure: false };
      switch ( kind ) {
        case "attack": {
          if ( hudBlock ) this.#startHudResult(item, true);
          const config = { event };
          if ( mode === "advantage" ) config.advantage = true;
          else if ( mode === "disadvantage" ) config.disadvantage = true;
          await rollActivity.rollAttack(config, dialog, message);
          this.#markUsed(block);
          break;
        }
        case "damage": {
          const last = this.#quick.getLastAttack(activity);
          const isCritical = (mode === "critical") || ((mode === "auto") && !!last?.critical);
          const config = { event, isCritical };
          if ( last?.attackMode ) config.attackMode = last.attackMode;
          const ammunition = last?.ammunition ? this.actor.items.get(last.ammunition) : null;
          if ( ammunition ) config.ammunition = ammunition;
          await rollActivity.rollDamage(config, dialog, message);
          if ( cast && !cast.sticky ) this.#quick.casts.delete(item.id);
          break;
        }
        case "heal":
          if ( hudBlock ) this.#startHudResult(item, true);
          await rollActivity.rollDamage({ event }, dialog, message);
          this.#markUsed(block);
          if ( cast && !cast.sticky ) this.#quick.casts.delete(item.id);
          break;
        default:
          // Salvación o Usar: la tarjeta del lanzamiento ya está en el chat (con la CD y sus botones).
          if ( hudBlock ) this.#startHudResult(item, !!activity.damage?.parts?.length);
          this.#markUsed(block);
          if ( cast && !cast.sticky && !activity.damage?.parts?.length ) this.#quick.casts.delete(item.id);
      }
    } catch(err) {
      useError(`${tag} | Error`, err);
      ui.notifications.error(game.i18n.format("BHD.Use.Error", { name: item.name, error: err?.message ?? String(err) }));
    } finally {
      this.#using = false;
      button?.classList.remove("bhd-rolling");
      this.#renderRows();
    }
  }

  /**
   * "Lanza" una actividad: `activity.use` sin ventana y sin tiradas automáticas (las hace cada botón).
   * dnd5e gasta el espacio elegido en la fila, los usos o la cantidad, empieza la concentración
   * (terminando la anterior si hace falta), coloca el área y crea la tarjeta del chat.
   * @param {Item} item
   * @param {Activity} activity
   * @param {Event} [event]
   * @param {string} tag  Prefijo del registro.
   * @returns {Promise<object|null>}  El lanzamiento, o null si no se pudo (dnd5e ya avisó por qué).
   */
  async #cast(item, activity, event, tag) {
    const actor = item.actor;
    const usage = { event, subsequentActions: false };
    const slot = this.#quick.getSlot(activity);
    if ( slot ) usage.spell = { slot };
    const concentrating = Array.from(actor.concentration?.effects ?? []).map(effect => ({
      id: effect.id,
      name: actor.items.get(effect.getFlag("dnd5e", "item")?.id)?.name ?? effect.name
    }));
    useLog(`${tag} | Lanzamiento`, { slot });
    const results = await activity.use(usage, { configure: needsUsageDialog(activity) }, {});
    if ( !results ) {
      useLog(`${tag} | No se lanzó (sin espacios, sin usos o cancelado)`);
      return null;
    }
    for ( const previous of concentrating ) {
      if ( !actor.effects.has(previous.id) ) {
        ui.notifications.info(game.i18n.format("BHD.Status.ConcentrationReplaced", { name: previous.name }));
      }
    }
    const message = results.message;
    if ( message instanceof foundry.documents.ChatMessage ) this.#openTray(message);
    const cast = {
      activityId: activity.id,
      slot,
      scaling: getScaling(activity, slot),
      messageId: message?.id ?? null,
      time: Date.now(),
      turnKey: getTurnKey(),
      sticky: (item.type === "spell") && needsCast(item, activity)
    };
    this.#quick.casts.set(item.id, cast);
    return cast;
  }

  /**
   * "Más opciones": el uso normal de dnd5e con todas sus ventanas (munición, modo de ataque...).
   * @param {Item} item
   * @param {Activity|null} activity
   * @param {Event} [event]
   */
  async #useFull(item, activity, event) {
    if ( this.#using ) return;
    this.#using = true;
    this.#fullOptionsItem = item.id;
    this.#prepareTray(item);
    try {
      const result = await (activity ?? item).use({ event });
      const message = result?.message ?? result;
      if ( message instanceof foundry.documents.ChatMessage ) this.#openTray(message);
    } catch(err) {
      useError(`${item.name} (más opciones) | Error`, err);
      ui.notifications.error(game.i18n.format("BHD.Use.Error", { name: item.name, error: err?.message ?? String(err) }));
    } finally {
      this.#using = false;
    }
  }

  /**
   * Marca como usado en el turno un bloque (acción, adicional, reacción) si el personaje está en combate.
   * @param {string} [block]
   */
  #markUsed(block) {
    const own = getOwnCombatant(this.actor);
    if ( !own || !ECONOMY_BLOCKS.includes(block) ) return;
    setEconomy(own.combat, own.combatant, { [block]: true }).catch(err => {
      console.error("BHD Companion | No se pudo marcar la acción como usada", err);
    });
  }

  /** Vuelve a dibujar las filas con botones (crítico, lanzamiento) si se ven. */
  #renderRows() {
    if ( ["actions", "combat"].includes(this.activeTab) ) this.render({ parts: ["main"] });
  }

  /**
   * Hooks `dnd5e.preRollAttackV2` / `dnd5e.preRollDamageV2`: las tiradas de este personaje (también
   * las de los botones de las tarjetas del panel) salen sin ventana. Con "Más opciones" se deja la
   * ventana normal de dnd5e.
   * @param {"attack"|"damage"} type
   * @param {object} config  Configuración de la tirada (config.subject es la actividad).
   * @param {object} dialog  Configuración de la ventana.
   */
  onPreRoll(type, config, dialog) {
    const activity = config.subject;
    if ( !activity || (activity.actor !== this.actor) || (activity.item.id === this.#fullOptionsItem) ) return;
    dialog.configure = false;
  }

  /* -------------------------------------------- */

  /**
   * Prepara el panel de resultados para un objeto: si mostraba otro, se vacía.
   * @param {Item} item
   */
  #prepareTray(item) {
    if ( this.#trayItemId === item.id ) return;
    this.#trayItemId = item.id;
    this.#trayMessages = [];
  }

  /**
   * Abre el panel de resultados con un mensaje (tarjeta del objeto o tirada).
   * @param {ChatMessage} message
   */
  #openTray(message) {
    const itemId = message.getFlag("dnd5e", "item.id");
    if ( itemId && (itemId !== this.#trayItemId) ) {
      this.#trayItemId = itemId;
      this.#trayMessages = [];
    }
    if ( this.#trayMessages.includes(message.id) ) return;
    this.#trayMessages.push(message.id);
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
    if ( wasHidden && (elements.length === 1) ) log.scrollTop = 0;
    else elements.at(-1)?.scrollIntoView({ block: "nearest" });
  }

  /**
   * Llamado desde los hooks del chat:
   * - Avisa de las salvaciones que el mensaje pide al personaje.
   * - Añade al panel las tiradas del objeto que se ve (las de sus botones y las de su tarjeta) y lo
   *   actualiza si alguna de sus tarjetas cambia o se borra.
   * @param {ChatMessage} message
   * @param {"create"|"update"|"delete"} action
   */
  onChatMessage(message, action) {
    if ( action === "create" ) this.#checkSavePrompts(message);
    else if ( action === "delete" ) this.#dropSavePrompts(message.id);

    if ( !this.#trayItemId ) return;
    if ( action === "create" ) {
      const origin = message.getFlag("dnd5e", "originatingMessage");
      const ownRoll = message.isAuthor && (message.getFlag("dnd5e", "item.id") === this.#trayItemId)
        && (message.speaker?.actor === this.actor?.id);
      if ( !ownRoll && !this.#trayMessages.includes(origin) ) return;
      if ( this.#trayMessages.includes(message.id) ) return;
      this.#trayMessages.push(message.id);
    }
    else if ( !this.#trayMessages.includes(message.id) ) return;
    else if ( action === "delete" ) this.#trayMessages.findSplice(id => id === message.id);
    this.#renderTray();
  }

  /**
   * Llamado desde los hooks de tiradas de dnd5e: muestra en el teléfono el total de un ataque o daño
   * hecho por este personaje y recuerda si el ataque fue crítico (el botón Daño lo tira crítico).
   * @param {"attack"|"damage"} type
   * @param {Roll[]} rolls
   * @param {Activity} [subject]
   */
  onActivityRoll(type, rolls, subject) {
    const actor = this.actor;
    if ( !actor || !rolls?.length || (subject?.actor !== actor) ) return;
    const name = subject.item?.name ?? "";
    const key = `${subject.item.id}.${subject.id}`;
    const result = (this.#hudResult?.itemId === subject.item?.id) ? this.#hudResult : null;
    if ( type === "attack" ) {
      const roll = rolls[0];
      useLog(`${name} | Ataque: ${roll.total}${roll.isCritical ? " (crítico)" : ""}`);
      this.#quick.attacks.set(key, {
        critical: !!roll.isCritical,
        ammunition: roll.options?.ammunition || null,
        attackMode: roll.options?.attackMode || null
      });
      this.#showRollResult(`${name}: ${game.i18n.localize("BHD.Actions.Attack")}`, roll);
      if ( result ) {
        result.attack = { total: roll.total, crit: !!roll.isCritical, fumble: !!roll.isFumble };
        result.verdicts = this.#getAttackVerdicts(roll);
      }
      if ( !this.#using ) this.#renderRows();
      return;
    }
    const total = rolls.reduce((sum, roll) => sum + (roll.total ?? 0), 0);
    useLog(`${name} | Daño: ${total}`);
    // El crítico ya se usó: el siguiente daño vuelve a ser normal.
    this.#quick.attacks.delete(key);
    const label = subject.damageFlavor ?? game.i18n.localize("BHD.Actions.Damage");
    this.#showRollResult(`${name}: ${label}`, { total, isCritical: rolls[0]?.isCritical });
    if ( result ) {
      result.damage = { total, label };
      result.hint = null;
    }
    if ( !this.#using ) this.#renderRows();
  }

  /* -------------------------------------------- */
  /*  Salvaciones pendientes                      */
  /* -------------------------------------------- */

  /**
   * Si el mensaje pide una salvación al personaje, la pone en cola y muestra el aviso.
   * @param {ChatMessage} message
   */
  #checkSavePrompts(message) {
    let added = false;
    for ( const prompt of findSavePrompts(message, this.actor) ) {
      if ( this.#seenPrompts.has(prompt.id) ) continue;
      this.#seenPrompts.add(prompt.id);
      this.#savePrompts.push(prompt);
      added = true;
    }
    if ( !added ) return;
    useLog("Salvación pendiente", this.#savePrompts.at(-1));
    this.#showSaveAlert(true);
  }

  /**
   * Quita los avisos de un mensaje borrado.
   * @param {string} messageId
   */
  #dropSavePrompts(messageId) {
    const before = this.#savePrompts.length;
    this.#savePrompts = this.#savePrompts.filter(p => p.messageId !== messageId);
    if ( this.#savePrompts.length !== before ) this.#showSaveAlert(false);
  }

  /**
   * Muestra el aviso de la primera salvación pendiente (o lo oculta si no queda ninguna).
   * @param {boolean} vibrate
   */
  #showSaveAlert(vibrate) {
    const alert = this.element?.querySelector(".bhd-save-alert");
    const prompt = this.#savePrompts[0];
    const actor = this.actor;
    if ( !alert ) return;
    if ( !prompt || !actor ) {
      alert.hidden = true;
      return;
    }
    const localize = key => game.i18n.localize(key);
    const concentration = prompt.type === "concentration";
    const more = this.#savePrompts.length - 1;
    alert.innerHTML = `
      <div class="bhd-save-alert-box ${concentration ? "bhd-save-concentration" : ""}">
        <i class="fa-solid ${concentration ? "fa-brain" : "fa-shield-heart"} bhd-save-alert-icon" aria-hidden="true"></i>
        <strong class="bhd-save-alert-title">${localize(concentration ? "BHD.Save.ConcentrationTitle" : "BHD.Save.Title")}</strong>
        <span class="bhd-save-alert-source"></span>
        <button type="button" class="bhd-big-btn bhd-save-alert-roll" data-action="bhdSaveRoll">
          <i class="fa-solid fa-dice-d20" aria-hidden="true"></i> <span></span>
        </button>
        <button type="button" class="bhd-save-alert-later" data-action="bhdSaveDismiss">${localize("BHD.Save.Later")}</button>
        ${more > 0 ? `<span class="bhd-save-alert-more">${game.i18n.format("BHD.Save.More", { count: more })}</span>` : ""}
      </div>`;
    alert.querySelector(".bhd-save-alert-source").textContent = prompt.source
      ? game.i18n.format("BHD.Save.From", { source: prompt.source }) : "";
    alert.querySelector(".bhd-save-alert-roll span").textContent = getSavePromptLabel(prompt, actor);
    alert.hidden = false;
    if ( !vibrate ) return;
    try {
      if ( navigator.userActivation?.hasBeenActive ?? true ) navigator.vibrate?.([200, 100, 200]);
    } catch(err) {}
  }

  /* -------------------------------------------- */
  /*  HUD de combate                              */
  /* -------------------------------------------- */

  /**
   * Empieza a mostrar en el HUD el resultado de un uso (el ataque y el daño se completan al tirarlos).
   * @param {Item} item
   * @param {boolean} hasDamage  ¿Mostrar la pista "toca Daño"?
   */
  #startHudResult(item, hasDamage) {
    this.#hudResult = {
      itemId: item.id,
      name: item.name,
      img: item.img,
      attack: null,
      verdicts: [],
      damage: null,
      hint: hasDamage ? game.i18n.localize("BHD.Hud.Result.DamageHint") : null
    };
  }

  /**
   * Hook `dnd5e.postUseActivity`: el personaje usó algo (desde otra parte que no son los botones de la
   * vista, p. ej. un botón de una tarjeta). En combate, marca como usado el bloque de su tipo de acción.
   * @param {Activity} activity
   */
  onPostUseActivity(activity) {
    if ( (activity.actor !== this.actor) || this.#using ) return;
    this.#markUsed(activity.activation?.type);
  }

  /**
   * ¿Impactó o falló a cada objetivo? Igual que la tarjeta de ataque de dnd5e: un crítico siempre
   * impacta, una pifia siempre falla y, si no, el total contra la CA. Al jugador no se le dice la CA.
   * @param {Roll} roll
   * @returns {{id: string, name: string, label: string}[]}
   */
  #getAttackVerdicts(roll) {
    if ( !game.settings.get(MODULE_ID, "showAttackResult") ) return [];
    return dnd5e.utils.getTargetDescriptors().map(({ name, ac }) => {
      let hit;
      if ( roll.isCritical ) hit = true;
      else if ( roll.isFumble ) hit = false;
      else if ( Number.isFinite(ac) ) hit = roll.total >= ac;
      else return null; // CA desconocida (p. ej. cobertura total)
      return { id: hit ? "hit" : "miss", name, label: game.i18n.localize(hit ? "BHD.Hud.Result.Hit" : "BHD.Hud.Result.Miss") };
    }).filter(v => v);
  }

  /** Vuelve a dibujar el contenido si se está viendo la pestaña Combate. */
  #renderCombatTab() {
    if ( this.activeTab === "combat" ) this.render({ parts: ["main"] });
  }

  /**
   * Acción básica (Esquivar, Correr, Destrabarse, Ayudar, Esconderse, Buscar, Preparar):
   * la anuncia en el chat (la ve el DM en la TV), tira la habilidad si corresponde, pone el
   * estado "Esquivando" y marca la acción como usada. Correr además dobla la velocidad del turno.
   * @param {object} basic  Entrada de BASIC_ACTIONS.
   * @param {PointerEvent} event
   */
  async #useBasicAction(basic, event) {
    const actor = this.actor;
    if ( !actor || this.#using ) return;
    const label = game.i18n.localize(`BHD.Hud.Basic.${basic.id}.Name`);
    if ( basic.target ) {
      const ids = await this.#pickTargets({ title: label, max: 1 });
      if ( ids === null ) return;
      setTargets(ids);
    }
    this.#using = true;
    try {
      await this.#postBasicAction(actor, basic, label);
      if ( basic.status && CONFIG.statusEffects.some(e => e.id === basic.status) ) {
        await actor.toggleStatusEffect(basic.status, { active: true });
      }
      if ( basic.skill ) {
        const rolls = await actor.rollSkill({ skill: basic.skill, event }, { configure: false });
        this.#showRollResult(label, rolls?.[0]);
      }
      else this.#showRollResult(label, { total: "✓" });
      const own = getOwnCombatant(actor);
      if ( own ) await setEconomy(own.combat, own.combatant, { action: true, ...(basic.id === "dash" ? { dash: true } : {}) });
    } finally {
      this.#using = false;
    }
  }

  /**
   * Mensaje del chat que anuncia una acción básica (con su objetivo, si tiene).
   * @param {Actor} actor
   * @param {object} basic
   * @param {string} label
   */
  async #postBasicAction(actor, basic, label) {
    const escape = foundry.utils.escapeHTML;
    const targets = basic.target ? prepareTargetChips().map(t => t.name).join(", ") : "";
    const content = `
      <div class="bhd-chat-basic">
        <p><strong>${escape(label)}</strong></p>
        <p>${escape(game.i18n.localize(`BHD.Hud.Basic.${basic.id}.Chat`))}</p>
        ${targets ? `<p><i class="fa-solid fa-crosshairs" aria-hidden="true"></i> ${escape(targets)}</p>` : ""}
      </div>`;
    await ChatMessage.implementation.create({
      speaker: ChatMessage.implementation.getSpeaker({ actor }),
      content
    });
  }

  /* -------------------------------------------- */
  /*  Selector de objetivos                       */
  /* -------------------------------------------- */

  /**
   * Abre el selector de objetivos y espera a que el jugador elija.
   * Con un solo objetivo, tocar una tarjeta ya lo elige; con varios, se marcan y se confirma.
   * @param {object} options
   * @param {string} options.title
   * @param {string} [options.img]
   * @param {number} [options.max=1]      Objetivos como mucho (0 = sin límite).
   * @param {boolean} [options.manual]    Abierto con "Elegir" (sin usar nada después).
   * @returns {Promise<string[]|null>}  Ids de las fichas elegidas, [] sin objetivo, null si se canceló.
   */
  async #pickTargets({ title, img, max=1, manual=false }) {
    const element = this.element.querySelector(".bhd-picker");
    if ( !element ) return null;
    this.#closePicker(null);
    const cards = prepareTargetCards(this.actor);
    const multi = manual || (max !== 1);
    // Con más objetivos marcados de los que se pueden elegir, se empieza de cero.
    let selected = cards.filter(c => c.selected).map(c => c.id);
    if ( max && (selected.length > max) ) selected = [];
    for ( const card of cards ) card.selected = selected.includes(card.id);

    let subtitle;
    if ( manual ) subtitle = game.i18n.localize("BHD.Hud.Picker.ManualHint");
    else if ( max === 1 ) subtitle = game.i18n.localize("BHD.Hud.Picker.One");
    else subtitle = game.i18n.format("BHD.Hud.Picker.Many", { max });

    element.innerHTML = await foundry.applications.handlebars.renderTemplate(`${TEMPLATE_PATH}/mobile/target-picker.hbs`, {
      title, img, subtitle, cards, multi,
      noneLabel: game.i18n.localize(manual ? "BHD.Hud.ClearTargets" : "BHD.Hud.Picker.None")
    });
    const promise = new Promise(resolve => {
      this.#picker = { resolve, max, multi, selected: new Set(selected) };
    });
    this.#updatePickerConfirm();
    element.hidden = false;
    return promise;
  }

  /**
   * Cierra el selector de objetivos y devuelve lo elegido a quien lo abrió.
   * @param {string[]|null} result
   */
  #closePicker(result) {
    const picker = this.#picker;
    this.#picker = null;
    const element = this.element?.querySelector(".bhd-picker");
    if ( element ) element.hidden = true;
    picker?.resolve(result);
  }

  /** Texto del botón Confirmar: cuántos objetivos van marcados. */
  #updatePickerConfirm() {
    const picker = this.#picker;
    const button = this.element.querySelector("[data-bhd-pick-confirm]");
    if ( !picker || !button ) return;
    const count = picker.selected.size;
    button.textContent = picker.max
      ? game.i18n.format("BHD.Hud.Picker.ConfirmMax", { count, max: picker.max })
      : game.i18n.format("BHD.Hud.Picker.Confirm", { count });
  }

  /* -------------------------------------------- */
  /*  Pestaña Mover                               */
  /* -------------------------------------------- */

  /**
   * Manda al DM un paso, deshacer o reiniciar, de uno en uno y en el orden en que se tocaron.
   * Si uno falla (pared, no es tu turno...), los que esperaban en cola se descartan.
   * @param {"step"|"undo"|"reset"} action
   * @param {string} [direction]
   */
  #queueMovement(action, direction) {
    const token = getMoveToken(this.actor, this.#moveTokenId);
    if ( !token || (this.#moveQueued >= 3) ) return;
    this.#moveQueued++;
    const generation = this.#moveGeneration;
    this.#moveQueue = this.#moveQueue.then(async () => {
      try {
        if ( generation !== this.#moveGeneration ) return;
        const result = await requestMovement(action, token, direction);
        if ( !result.ok ) {
          this.#moveGeneration++;
          this.#onMoveFailed(result.reason);
        }
      } catch(err) {
        console.error("BHD Companion | No se pudo mover la ficha", err);
      } finally {
        this.#moveQueued--;
      }
    });
  }

  /**
   * Explica por qué no se movió la ficha. Si chocó con una pared o puerta, además vibra
   * y la cruceta tiembla (los iPhone no vibran).
   * @param {string} reason  Clave de BHD.Move.Reason.*
   */
  #onMoveFailed(reason) {
    ui.notifications.warn(`BHD.Move.Reason.${reason}`, { localize: true });
    if ( reason !== "Wall" ) return;
    try {
      if ( navigator.userActivation?.hasBeenActive ?? true ) navigator.vibrate?.([80, 60, 80]);
    } catch(err) {}
    const pad = this.element?.querySelector("[data-bhd-dpad]");
    if ( !pad ) return;
    pad.classList.remove("bhd-shake");
    void pad.offsetWidth; // reinicia la animación si ya estaba temblando
    pad.classList.add("bhd-shake");
    pad.addEventListener("animationend", () => pad.classList.remove("bhd-shake"), { once: true });
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
    const firstCheck = !this.#combatChecked;
    this.#combatChecked = true;
    if ( !isActorTurn(combat, actor) ) {
      this.#hideTurnAlert();
      return;
    }
    const key = `${combat.id}-${combat.round}-${combat.turn}`;
    if ( key === this.#alertedTurn ) return;
    this.#alertedTurn = key;
    this.#showTurnAlert(combat, actor);
    // Esquivar dura hasta el principio del siguiente turno. Al abrir la vista no se quita:
    // puede que el jugador haya recargado la página en el mismo turno en que esquivó.
    if ( !firstCheck && actor.statuses.has("dodging") ) {
      actor.toggleStatusEffect("dodging", { active: false }).catch(err => {
        console.error("BHD Companion | No se pudo quitar Esquivar", err);
      });
    }
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
    await this.#switchTab(tab);
  }

  /**
   * Muestra otra pestaña. Solo la pestaña visible tiene contenido (ver _prepareContext):
   * hay que dibujar la nueva.
   * @param {string} tab
   */
  async #switchTab(tab) {
    this.tabGroups.primary = tab;
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
   * Botón de tirada de una fila (Ataque, Daño, Salvación, Curar, Usar).
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onQuick(event, target) {
    // Al soltar un toque largo también llega un clic: ese ya abrió el menú, no se tira.
    if ( this.#longPress?.fired && (this.#longPress.target === target) ) {
      this.#longPress = null;
      return;
    }
    const { kind, itemId, activityId, hudBlock } = target.dataset;
    const item = this.actor?.items.get(itemId);
    if ( !item ) return;
    const activity = activityId ? item.system.activities?.get(activityId) : null;
    await this.#runQuick(kind, item, activity ?? null, { event, button: target, hudBlock });
  }

  /**
   * Botón del menú del toque largo: Ventaja, Normal, Desventaja, Crítico o Más opciones.
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onChooseUse(event, target) {
    this.#closeChooser();
    const { kind, itemId, activityId, hudBlock, mode } = target.dataset;
    const item = this.actor?.items.get(itemId);
    if ( !item ) return;
    const activity = activityId ? item.system.activities?.get(activityId) : null;
    if ( mode === "full" ) await this.#useFull(item, activity, event);
    else await this.#runQuick(kind, item, activity ?? null, { mode, event, hudBlock });
  }

  /**
   * Termina el lanzamiento en curso de un hechizo: el próximo botón lo vuelve a lanzar (y gasta otro espacio).
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onEndCast(event, target) {
    this.#quick.casts.delete(target.dataset.itemId);
    this.#renderRows();
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
   * Tira la salvación del aviso con dnd5e (sin ventana) y muestra el resultado.
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   */
  static async #onSaveRoll(event) {
    const actor = this.actor;
    const prompt = this.#savePrompts.shift();
    this.#showSaveAlert(false);
    if ( !actor || !prompt ) return;
    try {
      const rolls = await rollSavePrompt(prompt, actor, event);
      const roll = rolls?.[0];
      if ( !roll ) return;
      let label = getSavePromptLabel(prompt, actor);
      if ( prompt.showDC && prompt.dc ) {
        label += ` · ${game.i18n.localize(roll.total >= prompt.dc ? "BHD.Save.Success" : "BHD.Save.Failure")}`;
      }
      this.#showRollResult(label, roll);
    } catch(err) {
      useError("Salvación | Error", err);
      ui.notifications.error(game.i18n.format("BHD.Use.Error", { name: getSavePromptLabel(prompt, actor), error: err?.message ?? String(err) }));
    }
  }

  /**
   * Cierra el aviso de salvación sin tirar (se puede tirar desde la tarjeta del chat o la hoja).
   * @this {BHDMobileApp}
   */
  static #onSaveDismiss() {
    this.#savePrompts.shift();
    this.#showSaveAlert(false);
  }

  /**
   * Termina la concentración en un hechizo (pregunta antes, para no hacerlo por un toque sin querer).
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onEndConcentration(event, target) {
    const actor = this.actor;
    const effect = actor?.effects.get(target.dataset.effectId);
    if ( !effect ) return;
    const name = target.dataset.name ?? effect.name;
    const confirmed = await DialogV2.confirm({
      window: { title: "BHD.Status.EndConcentrationTitle" },
      classes: ["bhd-dialog"],
      content: `<p>${foundry.utils.escapeHTML(game.i18n.format("BHD.Status.EndConcentrationContent", { name }))}</p>`,
      rejectClose: false
    });
    if ( confirmed ) await actor.endConcentration(effect);
  }

  /**
   * Explicación breve de una condición (Derribado, Envenenado...).
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onConditionInfo(event, target) {
    const info = await getConditionInfo(target.dataset.status, this.actor);
    if ( !info ) return;
    await this.#showInfo(info.name, info.img, info.html);
  }

  /**
   * Descripción de un efecto activo que no es una condición (Bendición, Bane...).
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onEffectInfo(event, target) {
    const effect = await fromUuid(target.dataset.uuid);
    if ( !effect ) return;
    const html = await foundry.applications.ux.TextEditor.implementation.enrichHTML(
      effect.description || `<p>${foundry.utils.escapeHTML(game.i18n.localize("BHD.Status.NoDescription"))}</p>`,
      { relativeTo: effect }
    );
    await this.#showInfo(effect.name, effect.img, html);
  }

  /**
   * Ventana sencilla con un título, un icono y un texto.
   * @param {string} title
   * @param {string} img
   * @param {string} html
   */
  async #showInfo(title, img, html) {
    const content = document.createElement("div");
    content.className = "bhd-item-info bhd-status-info";
    if ( img ) {
      const icon = document.createElement("img");
      icon.className = "bhd-status-info-img";
      icon.src = img;
      icon.alt = "";
      content.append(icon);
    }
    content.insertAdjacentHTML("beforeend", html);
    await DialogV2.prompt({
      window: { title },
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

  /**
   * Flecha de la cruceta: mueve la ficha una casilla en esa dirección.
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onMove(event, target) {
    this.#queueMovement("step", target.dataset.direction);
  }

  /**
   * Deshace el último paso.
   * @this {BHDMobileApp}
   */
  static #onMoveUndo() {
    this.#queueMovement("undo");
  }

  /**
   * Pone a cero los pies recorridos (solo fuera de combate).
   * @this {BHDMobileApp}
   */
  static #onMoveReset() {
    this.#queueMovement("reset");
  }

  /**
   * Toca un bloque del HUD: abre o cierra sus opciones. Movimiento lleva a la pestaña Mover.
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onHudBlock(event, target) {
    const block = target.dataset.block;
    if ( block === "move" ) {
      await this.#switchTab("move");
      return;
    }
    this.#hudBlock = (this.#hudBlock === block) ? null : block;
    this.#scrollToHud = !!this.#hudBlock;
    await this.render({ parts: ["main"] });
  }

  /**
   * Toca una acción básica del bloque Acción (Esquivar, Correr...).
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onHudBasic(event, target) {
    const basic = BASIC_ACTIONS.find(b => b.id === target.dataset.basic);
    if ( basic ) await this.#useBasicAction(basic, event);
  }

  /**
   * Marca a mano un bloque como usado o disponible (por si algo se marcó por error,
   * o el DM permite repetir, p. ej. con Oleada de acción).
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onHudMark(event, target) {
    const own = getOwnCombatant(this.actor);
    const block = target.dataset.block;
    if ( !own || !ECONOMY_BLOCKS.includes(block) ) return;
    const used = getEconomy(own.combat, own.combatant)[block];
    await setEconomy(own.combat, own.combatant, { [block]: !used });
  }

  /**
   * Cierra el resultado del último uso desde el HUD.
   * @this {BHDMobileApp}
   */
  static #onHudCloseResult() {
    this.#hudResult = null;
    this.#renderCombatTab();
  }

  /**
   * Toca un retrato del orden de iniciativa: marca o desmarca esa criatura como objetivo.
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onTarget(event, target) {
    const tokenId = target.dataset.tokenId;
    if ( !tokenId ) return;
    toggleTarget(tokenId);
    navigator.vibrate?.(15);
  }

  /**
   * Botón "Elegir" de la barra de objetivos: abre el selector sin usar nada después.
   * @this {BHDMobileApp}
   */
  static async #onPickTargets() {
    const ids = await this.#pickTargets({ title: game.i18n.localize("BHD.Hud.TargetsTitle"), max: 0, manual: true });
    if ( ids !== null ) setTargets(ids);
  }

  /**
   * Quita todos los objetivos.
   * @this {BHDMobileApp}
   */
  static #onClearTargets() {
    setTargets([]);
  }

  /**
   * Toca una tarjeta del selector: con un solo objetivo la elige ya; con varios, la marca o desmarca.
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onPickToggle(event, target) {
    const picker = this.#picker;
    const tokenId = target.dataset.tokenId;
    if ( !picker || !tokenId ) return;
    if ( !picker.multi ) {
      this.#closePicker([tokenId]);
      return;
    }
    const selected = picker.selected;
    if ( selected.has(tokenId) ) selected.delete(tokenId);
    else if ( picker.max && (selected.size >= picker.max) ) {
      ui.notifications.info(game.i18n.format("BHD.Hud.Picker.Full", { max: picker.max }));
      return;
    }
    else selected.add(tokenId);
    target.classList.toggle("bhd-on", selected.has(tokenId));
    target.setAttribute("aria-pressed", String(selected.has(tokenId)));
    this.#updatePickerConfirm();
  }

  /**
   * Confirma los objetivos marcados en el selector.
   * @this {BHDMobileApp}
   */
  static #onPickConfirm() {
    if ( this.#picker ) this.#closePicker([...this.#picker.selected]);
  }

  /**
   * Sigue sin objetivo (o, con "Elegir", quita todos).
   * @this {BHDMobileApp}
   */
  static #onPickNone() {
    this.#closePicker([]);
  }

  /**
   * Cierra el selector sin usar nada.
   * @this {BHDMobileApp}
   */
  static #onPickCancel() {
    this.#closePicker(null);
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
      classes: ["bhd-dialog"],
      content: `<p>${game.i18n.localize("BHD.Exit.Content")}</p>`,
      rejectClose: false
    });
    if ( !confirmed ) return;
    await game.settings.set(MODULE_ID, "preferNormal", true);
    reloadWithoutUrlMode();
  }
}
