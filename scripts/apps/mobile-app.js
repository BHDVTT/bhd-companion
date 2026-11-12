import { isMidiActive, MODULE_ID, TEMPLATE_PATH } from "../constants.js";
import { getActiveCharacter, getCharacterChoices, getTransformedForm, prepareCharacterSheet } from "./character-data.js";
import { requestRevertForm } from "../transform.js";
import { DiceTray } from "../dice-tray.js";
import { getCompanionActor, getCompanionTokens, prepareCompanionChoices } from "./companions-data.js";
import { adjustResource, prepareResources } from "./resources-data.js";
import { clearDiary, prepareDiary } from "../diary.js";
import { ACTION_FILTERS, normalizeSearch, prepareActions } from "./actions-data.js";
import { canTogglePrepared, getPreparationLimit, hasSpells, prepareSpellsTab, SPELL_ACTIVATIONS } from "./spells-data.js";
import { formatInitiative, getActiveCombat, isActorTurn, prepareCombat, prepareDeathSaves } from "./combat-data.js";
import { BASIC_ACTIONS, getTargetNeed, prepareHud, prepareTargetCards, prepareTargetChips } from "./combat-hud-data.js";
import { ECONOMY_BLOCKS, getEconomy, getOwnCombatant, setEconomy } from "../economy.js";
import { getTargetIds, setTargets, toggleTarget } from "../targets.js";
import { getRemoteBlock, requestMidiUse } from "../midi-remote.js";
import {
  needsAreaPlacement, requestPlacementEnd, requestPlacementMove, requestPlacementStart, ROTATE_STEP, waitForGmPlacement
} from "../template-placement.js";
import { prepareInventory } from "./inventory-data.js";
import { getMoveToken, prepareMovement } from "./move-data.js";
import { requestMovement } from "../movement.js";
import { getSavedNotes, localNotesDraft, NOTES_FLAG, prepareNotes } from "./notes-data.js";
import { applyLargeText, syncPlaylistSounds } from "../mobile-mode.js";
import { canKeepAwake, updateWakeLock } from "../wake-lock.js";
import { getInstallMode, promptInstall } from "../home-screen.js";
import { reloadWithoutUrlMode } from "../device.js";
import { useError, useLog, useWarn } from "../use-log.js";
import {
  getScaledActivity, getScaling, getSlotOptions, getTurnKey, needsCast, needsUsageDialog, QuickActionState, ROLL_KINDS
} from "../quick-actions.js";
import { applyEnchantment, prepareEnchantPicker, removeEnchantment } from "../enchantments.js";
import {
  canRemoveEffect, describeEffect, getConditionInfo, getDuration, getEffectChanges, prepareStatus
} from "./status-data.js";
import { findSavePrompts, getSavePromptLabel, rollSavePrompt } from "../save-prompts.js";
import { rollMidiChatSave } from "../midi-chat-saves.js";
import { renderItemDetails } from "../item-details.js";
import { BUSY_TIMEOUT_MS, BusyLocks, withTimeout } from "../busy.js";
import { cancelPendingCalls } from "../remote-socket.js";
import { restartConnection } from "../connection.js";
import { chooseSummonOptions, needsSummonPlacement, requestSummonEnd, requestSummonMove, requestSummonStart, setLocalSummonPlacements } from "../summon-placement.js";
import { dequeuePrompt, enqueuePrompt, hasPendingPrompts, isActivePrompt, onPromptQueueChange, setPromptDeadline } from "../prompt-queue.js";
import { cancelAllDecisions, isDecisionShown } from "../decisions.js";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

/** Cuánto tiempo (ms) se ve el resultado de una tirada en el teléfono. */
const TOAST_DURATION = 4000;

/** Cuánto tiempo (ms) se ve el resultado de un uso hecho por el DM con Midi QOL. */
const MIDI_RESULT_DURATION = 12000;

/**
 * Cuánto hay que mantener el dedo (ms) para abrir el menú (ventaja / crítico). Menos que el toque largo del
 * sistema (iPhone ~500 ms: lupa / selección; Android: menú del navegador), para llegar antes que él.
 */
const LONG_PRESS_MS = 400;

/** Cuánto se puede mover el dedo (px) sin que deje de contar como toque largo. */
const LONG_PRESS_TOLERANCE = 12;

/** Cuánto (ms) después de soltar un toque largo se descarta el clic que manda el navegador. */
const LONG_PRESS_CLICK_GUARD = 700;

/** Botones con toque largo: menú de ventaja / normal / desventaja (o normal / crítico en Daño). */
const LONG_PRESS_SELECTOR = [
  '.bhd-roll-btn[data-kind="attack"]', '.bhd-roll-btn[data-kind="damage"]', '.bhd-roll-btn[data-kind="midi"]',
  '.bhd-rollable[data-type="ability"]', '.bhd-rollable[data-type="save"]', '.bhd-rollable[data-type="skill"]',
  '.bhd-rollable[data-type="death"]', ".bhd-save-alert-roll[data-midi-chat]"
].join(", ");

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
      bhdUseInspiration: BHDMobileApp.#onUseInspiration,
      bhdInspirationRule: BHDMobileApp.#onInspirationRule,
      bhdQuick: BHDMobileApp.#onQuick,
      bhdEndCast: BHDMobileApp.#onEndCast,
      bhdEndConcentration: BHDMobileApp.#onEndConcentration,
      bhdConditionInfo: BHDMobileApp.#onConditionInfo,
      bhdEffectInfo: BHDMobileApp.#onEffectInfo,
      bhdSaveRoll: BHDMobileApp.#onSaveRoll,
      bhdSaveDismiss: BHDMobileApp.#onSaveDismiss,
      bhdSaveMode: BHDMobileApp.#onSaveMode,
      itemInfo: BHDMobileApp.#onItemInfo,
      actionFilter: BHDMobileApp.#onActionFilter,
      closeTray: BHDMobileApp.#onCloseTray,
      chooseUse: BHDMobileApp.#onChooseUse,
      bhdCheckMode: BHDMobileApp.#onCheckMode,
      bhdReconnect: BHDMobileApp.#onReconnect,
      bhdChooseSlot: BHDMobileApp.#onChooseSlot,
      bhdPlaceRotate: BHDMobileApp.#onPlaceRotate,
      bhdPlaceConfirm: BHDMobileApp.#onPlaceConfirm,
      bhdPlaceCancel: BHDMobileApp.#onPlaceCancel,
      bhdSpellToggle: BHDMobileApp.#onSpellToggle,
      bhdSpellActivation: BHDMobileApp.#onSpellActivation,
      bhdSlotPip: BHDMobileApp.#onSlotPip,
      bhdPrepare: BHDMobileApp.#onPrepare,
      bhdMidiResultClose: BHDMobileApp.#onMidiResultClose,
      bhdReactionUse: BHDMobileApp.#onReactionUse,
      bhdReactionPass: BHDMobileApp.#onReactionPass,
      bhdEnchantOpen: BHDMobileApp.#onEnchantOpen,
      bhdEnchantPick: BHDMobileApp.#onEnchantPick,
      bhdEnchantRemove: BHDMobileApp.#onEnchantRemove,
      closeChooser: BHDMobileApp.#onCloseChooser,
      endTurn: BHDMobileApp.#onEndTurn,
      dismissTurnAlert: BHDMobileApp.#onDismissTurnAlert,
      bhdCompanion: BHDMobileApp.#onCompanion,
      bhdRevertForm: BHDMobileApp.#onRevertForm,
      bhdDiceTray: BHDMobileApp.#onDiceTray,
      bhdResource:BHDMobileApp.#onResource,
      bhdResourceStep: BHDMobileApp.#onResourceStep,
      bhdDiaryFilter: BHDMobileApp.#onDiaryFilter,
      bhdDiaryClear: BHDMobileApp.#onDiaryClear,
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
        `${TEMPLATE_PATH}/mobile/resources.hbs`,
        `${TEMPLATE_PATH}/mobile/spells.hbs`,
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
        { id: "spells", icon: "fa-solid fa-wand-sparkles" },
        { id: "combat", icon: "fa-solid fa-swords" },
        { id: "move", icon: "fa-solid fa-arrows-up-down-left-right" },
        { id: "inventory", icon: "fa-solid fa-sack" },
        { id: "notes", icon: "fa-solid fa-scroll" }
      ]
    }
  };

  /** Cantidad escrita en el control de vida (se conserva si la vista se vuelve a dibujar). */
  #hpAmount = "";

  /**
   * Botones ocupados: "roll" (características, salvaciones, habilidades...) y "use" (objetos, hechizos, acciones).
   * Evitan tiradas o usos dobles por tocar dos veces y se liberan siempre (como mucho a los 10 s).
   */
  #busy = new BusyLocks({
    isWaiting: () => this.#isWaitingForPlayer(),
    onTimeout: lock => this.#onBusyTimeout(lock)
  });

  /** Objetos con un uso pedido al DM (Midi) sin respuesta: no se piden dos veces aunque el botón ya esté libre. */
  #midiPending = new Set();

  /** Hasta cuándo (ms) se ignora el clic que llega al soltar un toque largo. */
  #suppressClickUntil = 0;

  /** Escuchadores ya puestos en cada elemento de la vista (para no repetirlos al redibujar). */
  #boundListeners = new WeakMap();

  /** Temporizador del aviso con el resultado de la tirada. */
  #toastTimeout;

  /** Filtro de la pestaña Acciones: "all", "action", "bonus" o "reaction". */
  #actionFilter = "all";

  /** Texto del buscador de hechizos. */
  #spellSearch = "";

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
   * Salvaciones por chat de Midi que ya salieron del aviso (tiradas aquí o por Midi), por id: para no volver a
   * mostrarlas si el DM las reenvía, y para enseñar el resultado cuando llegue.
   * @type {Map<string, {prompt: object, rolledHere: boolean, total: number|null}>}
   */
  #midiChatDone = new Map();

  /** Reloj de la cuenta atrás del aviso de salvación (salvaciones por chat de Midi). */
  #saveTick = null;

  /**
   * Mensajes del chat que se ven en el panel de resultados: la tarjeta del último objeto usado
   * y las tiradas que salen de ella (ataque, daño...).
   * @type {string[]}
   */
  #trayMessages = [];

  /** Contador para descartar dibujos del panel que ya quedaron viejos. */
  #trayRender = 0;

  /** Tarjeta del chat de un uso hecho por el DM que aún no llegó a este teléfono (se abre al llegar). */
  #pendingTrayId = null;

  /** Temporizador del resultado de un uso con Midi QOL. */
  #midiResultTimeout;

  /**
   * Colocación de un área en curso (con Midi): sesión en el DM, último estado y a quién devolver la posición.
   * @type {{sessionId: string, item: Item, state: object, busy: boolean, resolve: Function}|null}
   */
  #place = null;

  /** Flecha de "Colocar área" que se mantiene pulsada (para mover rápido). */
  #placeHold = null;

  /**
   * Aviso de reacción abierto (Midi ofrece Shield, Hellish Rebuke...).
   * @type {{activities: Activity[], resolve: Function, timer: number, tick: number}|null}
   */
  #reaction = null;

  /** Bandeja de dados (dice-tray.js). */
  #diceTray = null;

  /** Sitio del aviso de salvación en la cola única de preguntas (prompt-queue.js), mientras haya alguna. */
  #saveEntry = null;

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

  /** Compañero elegido en el selector de la cabecera (uuid de su ficha), o null: el personaje. */
  #companionUuid = null;

  /** Contador de recursos abierto en la pestaña Acciones (id del objeto o "resource.<clave>"). */
  #openResource = null;

  /**
   * Avisos ya dados de efectos con duración, por uuid del efecto: "last" (última ronda) o "ended" (terminó).
   * @type {Map<string, string>}
   */
  #effectNotices = new Map();

  /** Diario de la sesión (pestaña Notas): filtro elegido y si la sección está abierta. */
  #diaryFilter = "all";
  #diaryOpen = true;

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

  /** ¿Se veía la pestaña Combate en la última revisión? (null antes de la primera) */
  #combatTabShown = null;

  /** Aviso en la pestaña Combate: apareció un encuentro y el jugador aún no la abrió. */
  #combatBadge = false;

  /**
   * Filtros de la pestaña Hechizos.
   * @type {{level: string, activation: string, concentration: boolean, ritual: boolean, prepared: boolean, search: string}}
   */
  #spellFilters = { level: "all", activation: "all", concentration: false, ritual: false, prepared: null, readyOnly: false, search: "" };

  /** Pestaña visible ahora mismo. */
  get activeTab() {
    return this.tabGroups.primary;
  }

  /**
   * Personaje que se muestra ahora mismo.
   * @type {Actor|null}
   */
  get actor() {
    const character = getActiveCharacter();
    // Transformado (Wild Shape, Polymorph): la vista enseña la forma, con sus datos y acciones.
    return getCompanionActor(this.#companionUuid) ?? getTransformedForm(character) ?? character;
  }

  /**
   * El personaje del jugador (y su forma transformada, si la tiene) y sus compañeros en la escena (avisos de turno,
   * efectos, inspiración).
   * @returns {Actor[]}
   */
  get myActors() {
    const character = getActiveCharacter();
    return [character, getTransformedForm(character), ...getCompanionTokens().map(t => t.actor)].filter(a => a);
  }

  /**
   * Si el compañero elegido desapareció (fin de la invocación, ficha borrada), vuelve al personaje.
   * Llamar cuando cambian las fichas de la escena.
   */
  checkCompanion() {
    if ( !this.#companionUuid || getCompanionActor(this.#companionUuid) ) return;
    useLog("Compañero: su ficha ya no está en la escena; vuelvo al personaje");
    ui.notifications.info("BHD.Companion.Gone", { localize: true });
    this.#selectCompanion(null);
  }

  /**
   * Cambia el actor que muestra la vista: el personaje (null) o un compañero.
   * @param {string|null} tokenUuid
   */
  #selectCompanion(tokenUuid) {
    this.#companionUuid = tokenUuid || null;
    this.#openResource = null;
    this.#moveTokenId = null;
    this.#hudBlock = null;
    this.#hudResult = null;
    useLog(`Compañero: la vista muestra a ${this.actor?.name ?? "?"}`);
    this.render();
    this.onCombatUpdate();
  }

  /* -------------------------------------------- */

  /**
   * Solo se preparan y dibujan los datos de la pestaña que se ve: en teléfonos viejos, rehacer
   * todas las pestañas (lista de hechizos, inventario, biografía) con cada cambio de vida es lento.
   * Las demás se preparan al tocarlas (ver #onTab).
   * @override
   */
  async _prepareContext(options) {
    // Si la pestaña abierta dejó de existir (el encuentro se borró, no quedan hechizos), se vuelve a Personaje.
    const visible = this.#getVisibleTabs();
    if ( !visible.has(this.tabGroups.primary) ) this.tabGroups.primary = "character";
    const context = await super._prepareContext(options);
    const actor = this.actor;
    const tab = this.tabGroups.primary;
    context.userName = game.user.name;
    context.character = actor ? { name: actor.name, img: actor.img } : null;
    context.sheet = (actor && (tab === "character")) ? prepareCharacterSheet(actor) : null;
    context.hpAmount = this.#hpAmount;
    context.actions = (actor && (tab === "actions")) ? prepareActions(actor, this.#quick) : null;
    if ( context.actions ) context.actions.resources = prepareResources(actor, this.#openResource, this.#quick);
    context.spells = (actor && (tab === "spells")) ? prepareSpellsTab(actor, this.#quick, this.#spellFilters) : null;
    if ( context.spells ) this.#spellFilters.readyOnly = context.spells.readyOnly;
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
    if ( context.notes ) {
      context.notes.diary = prepareDiary(actor, this.#diaryFilter);
      context.notes.diaryOpen = this.#diaryOpen;
    }

    const choices = getCharacterChoices();
    const character = getActiveCharacter();
    context.choices = (choices.length > 1) ? choices.map(a => ({
      id: a.id, name: a.name, selected: a === character
    })) : null;
    const form = getTransformedForm(character);
    context.companions = prepareCompanionChoices(character, (actor !== character) ? this.#companionUuid : null);
    if ( context.companions && form ) {
      const own = context.companions.find(c => c.character);
      if ( own ) Object.assign(own, { name: form.name, img: form.img });
    }
    context.transformed = (form && (actor === form)) ? { name: form.name, original: character.name } : null;
    context.isCompanion = !!actor && (actor !== character) && (actor !== form);
    return context;
  }

  /**
   * Pestañas que se ven ahora: Combate solo si el personaje está en un encuentro de Foundry (aunque no haya
   * empezado) y Hechizos solo si tiene hechizos.
   * @returns {Set<string>}
   */
  #getVisibleTabs() {
    const actor = this.actor;
    const ids = new Set(this.constructor.TABS.primary.tabs.map(t => t.id));
    if ( !getActiveCombat(actor ?? null) ) ids.delete("combat");
    if ( !hasSpells(actor) ) ids.delete("spells");
    return ids;
  }

  /**
   * Pestañas de la barra de abajo: solo las visibles, con el aviso de Combate.
   * @override
   */
  _prepareTabs(group) {
    const tabs = super._prepareTabs(group);
    if ( group !== "primary" ) return tabs;
    const visible = this.#getVisibleTabs();
    for ( const id of Object.keys(tabs) ) {
      if ( !visible.has(id) ) delete tabs[id];
    }
    if ( tabs.combat ) {
      const actor = this.actor;
      const myTurn = isActorTurn(getActiveCombat(actor ?? null), actor);
      tabs.combat.dot = this.#combatBadge || myTurn;
      tabs.combat.myTurn = myTurn;
    }
    return tabs;
  }

  /**
   * La pestaña Combate aparece o desaparece. Al aparecer, lleva un aviso hasta que el jugador la abra;
   * al desaparecer, si el jugador estaba en ella, vuelve a Personaje.
   * @param {boolean} shown
   */
  #syncCombatTab(shown) {
    const before = this.#combatTabShown;
    this.#combatTabShown = shown;
    if ( before === shown ) return;
    if ( shown ) {
      this.#combatBadge = this.activeTab !== "combat";
      useLog("Combate: el personaje está en un encuentro; aparece la pestaña Combate");
    } else {
      this.#combatBadge = false;
      if ( before !== null ) useLog("Combate: el personaje ya no está en un encuentro; se quita la pestaña Combate");
    }
    if ( !this.rendered ) return;
    if ( !shown && (this.activeTab === "combat") ) this.#switchTab("character");
    else this.render({ parts: ["nav"] });
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

    // Toque largo en los botones de tirada (Ataque, Daño, características, habilidades...). Se escucha en el
    // contenedor (que no se vuelve a crear al redibujar), así sirve para todas las filas y nunca se duplica.
    // En iPhone y Android el navegador manda "pointercancel" en cuanto cree que el dedo va a desplazar la
    // lista (o a seleccionar texto); por eso, con el dedo, el movimiento se mide con los eventos táctiles.
    this.element.addEventListener("pointerdown", this.#onPointerDown.bind(this));
    this.element.addEventListener("pointermove", event => this.#onPressMove(event.clientX, event.clientY), { passive: true });
    this.element.addEventListener("touchmove", event => {
      const touch = event.touches?.[0];
      if ( touch ) this.#onPressMove(touch.clientX, touch.clientY);
    }, { passive: true });
    this.element.addEventListener("pointerup", () => this.#endPress());
    this.element.addEventListener("pointercancel", event => {
      if ( event.pointerType !== "touch" ) this.#endPress();
    });
    this.element.addEventListener("touchend", event => {
      // Tras un toque largo, que el navegador no mande además el clic (abriría o cerraría otra cosa).
      if ( this.#longPress?.fired && event.cancelable ) event.preventDefault();
      this.#endPress();
    }, { passive: false });
    this.element.addEventListener("touchcancel", () => this.#endPress());
    // Ni menú del navegador ni selección de texto en los botones con toque largo.
    this.element.addEventListener("contextmenu", event => {
      if ( this.#longPress || event.target.closest?.(LONG_PRESS_SELECTOR) ) event.preventDefault();
    });
    this.element.addEventListener("selectstart", event => {
      if ( event.target.closest?.(LONG_PRESS_SELECTOR) ) event.preventDefault();
    });
    // El clic que llega al soltar un toque largo se descarta antes de que llegue a ningún botón.
    document.addEventListener("click", event => {
      if ( Date.now() >= this.#suppressClickUntil ) return;
      this.#suppressClickUntil = 0;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, { capture: true });
    // Flechas de "Colocar área": un toque mueve una casilla; mantener pulsado mueve seguido.
    this.element.addEventListener("pointerdown", event => {
      const arrow = event.target.closest(".bhd-place-arrow");
      if ( arrow && (event.button === 0) ) this.#startPlaceHold(arrow);
    });
    for ( const type of ["pointerup", "pointercancel", "pointerleave"] ) {
      this.element.addEventListener(type, () => {
        if ( this.#placeHold ) this.#placeHold.active = false;
      });
    }
    this.element.addEventListener("contextmenu", event => {
      if ( event.target.closest(".bhd-place-arrow") ) event.preventDefault();
    });
    // Enlaces de las descripciones (reglas, condiciones, otros hechizos u objetos): en el teléfono no se abren
    // hojas ni diarios, así que lo enlazado se enseña en una ventana de la vista.
    document.addEventListener("click", event => {
      const link = event.target.closest?.(".bhd-item-info a.content-link[data-uuid]");
      if ( !link ) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.#openLinkedDocument(link.dataset.uuid);
    }, { capture: true });

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

    // Con Midi QOL: reacciones que ofrece Midi (con tiempo límite) y resultado de cada uso hecho por el DM.
    const reactionAlert = document.createElement("div");
    reactionAlert.className = "bhd-reaction-alert";
    reactionAlert.setAttribute("role", "alertdialog");
    reactionAlert.hidden = true;
    this.element.append(reactionAlert);
    onPromptQueueChange(() => this.#syncPromptAlerts());
    // Bandeja de dados (botón del dado en la cabecera).
    this.#diceTray = new DiceTray(this);
    onPromptQueueChange(() => this.#syncPromptAlerts());
    const midiResult = document.createElement("section");
    midiResult.className = "bhd-midi-result";
    midiResult.setAttribute("role", "status");
    midiResult.hidden = true;
    this.element.append(midiResult);

    // Panel de ajustes del teléfono (letra grande, pantalla encendida, música, instalar...).
    const settings = document.createElement("div");
    settings.className = "bhd-settings";
    settings.hidden = true;
    this.element.append(settings);

    // "Colocar área" (con Midi): cruceta, girar, quién queda dentro, Confirmar / Cancelar.
    const place = document.createElement("div");
    place.className = "bhd-place";
    place.hidden = true;
    this.element.append(place);

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
    // Cada elemento recibe cada escuchador una sola vez: al dibujar solo una parte (p. ej. "main"), los de la
    // cabecera siguen siendo los mismos y antes se les añadía otro escuchador en cada dibujo.
    const on = (element, type, listener) => {
      if ( !element ) return;
      let bound = this.#boundListeners.get(element);
      if ( !bound ) this.#boundListeners.set(element, bound = new Set());
      if ( bound.has(type) ) return;
      bound.add(type);
      element.addEventListener(type, listener);
    };
    on(this.element.querySelector("[data-bhd-hp-amount]"), "input", event => this.#hpAmount = event.currentTarget.value);
    on(this.element.querySelector("[data-bhd-character-select]"), "change",
      event => game.user.update({ character: event.currentTarget.value }));
    on(this.element.querySelector("[data-bhd-move-token]"), "change", event => {
      this.#moveTokenId = event.currentTarget.value;
      this.render({ parts: ["main"] });
    });
    on(this.element.querySelector("[data-bhd-spell-search]"), "input", event => {
      this.#spellSearch = event.currentTarget.value;
      this.#applyActionFilters();
    });
    this.#applyActionFilters();

    // Pestaña Hechizos: buscador y nivel (los demás filtros son botones).
    on(this.element.querySelector("[data-bhd-spelltab-search]"), "input", event => {
      this.#spellFilters.search = event.currentTarget.value;
      this.#applySpellFilters();
    });
    on(this.element.querySelector("[data-bhd-spell-level]"), "change", event => {
      this.#spellFilters.level = event.currentTarget.value;
      this.#applySpellFilters();
    });
    this.#applySpellFilters();

    // Nivel de espacio de los hechizos: cambia la fórmula de daño de la fila.
    for ( const select of this.element.querySelectorAll("[data-bhd-slot]") ) {
      on(select, "change", event => {
        this.#quick.slots.set(select.dataset.itemId, event.currentTarget.value);
        this.render({ parts: ["main"] });
      });
    }

    // Inventario: monedas editables y contenedores abiertos o cerrados.
    for ( const input of this.element.querySelectorAll("[data-bhd-currency]") ) {
      on(input, "change", this.#onCurrencyChange.bind(this));
      on(input, "focus", () => input.select());
    }
    for ( const [itemId, pending] of this.#pendingQuantities ) this.#showQuantity(itemId, pending.value);
    for ( const details of this.element.querySelectorAll(".bhd-inv-container") ) {
      on(details, "toggle", () => {
        if ( details.open ) this.#openContainers.add(details.dataset.containerId);
        else this.#openContainers.delete(details.dataset.containerId);
      });
    }
    // Diario: abierto o cerrado se recuerda al redibujar.
    on(this.element.querySelector("[data-bhd-diary]"), "toggle", event => {
      this.#diaryOpen = event.currentTarget.open;
    });

    // Notas personales: se guardan solas un momento después de dejar de escribir.
    const notes = this.element.querySelector("[data-bhd-notes]");
    on(notes, "change", () => this.#saveNotes());
    on(notes, "input", event => {
      const actor = this.actor;
      if ( !actor ) return;
      this.#notesDraft = { actorId: actor.id, text: event.currentTarget.value };
      localNotesDraft(actor.id, this.#notesDraft.text);
      this.#setNotesStatus("BHD.Notes.Unsaved");
      clearTimeout(this.#notesTimeout);
      this.#notesTimeout = setTimeout(() => this.#saveNotes(), NOTES_SAVE_DELAY);
    });

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
      if ( row.closest(".bhd-resources") ) continue;   // detalle de un recurso: siempre a la vista
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

  /**
   * Pestaña Hechizos: muestra u oculta filas según los filtros (nivel, tiempo, concentración, ritual,
   * preparados) y el buscador, sin volver a dibujar. Los niveles que quedan vacíos se ocultan.
   */
  #applySpellFilters() {
    const root = this.element?.querySelector(".bhd-spells-tab");
    if ( !root ) return;
    const filters = this.#spellFilters;
    const query = normalizeSearch(filters.search);
    for ( const row of root.querySelectorAll(".bhd-action") ) {
      const flags = (row.dataset.spellFlags ?? "").split(" ");
      const activation = (row.dataset.activation ?? "").split(" ");
      row.hidden = ((filters.level !== "all") && (row.dataset.level !== filters.level))
        || ((filters.activation !== "all") && !activation.includes(filters.activation))
        || (filters.concentration && !flags.includes("concentration"))
        || (filters.ritual && !flags.includes("ritual"))
        || (filters.readyOnly && !flags.includes("ready"))
        || (!!query && !row.dataset.search.includes(query));
    }
    // Subtítulos de clase (multiclase): solo si queda alguna fila suya a la vista.
    for ( const header of root.querySelectorAll("[data-class-header]") ) {
      let visible = false;
      for ( let el = header.nextElementSibling; el && !el.matches("[data-class-header]"); el = el.nextElementSibling ) {
        if ( el.matches(".bhd-action:not([hidden])") ) { visible = true; break; }
      }
      header.hidden = !visible;
    }
    const note = root.querySelector("[data-bhd-unprepared-note]");
    if ( note ) note.hidden = !filters.readyOnly;
    let any = false;
    const filtering = (filters.level !== "all") || (filters.activation !== "all") || filters.concentration
      || filters.ritual || filters.readyOnly || !!query;
    for ( const section of root.querySelectorAll("[data-spell-section]") ) {
      const empty = !section.querySelector(".bhd-action:not([hidden])");
      // Sin filtros, los niveles vacíos con espacios se ven (para gastar o recuperar a mano).
      section.hidden = filtering && empty;
      if ( !section.hidden ) any = true;
    }
    const none = root.querySelector("[data-bhd-no-spells]");
    if ( none ) none.hidden = any;
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
    const target = event.target.closest?.(LONG_PRESS_SELECTOR);
    if ( !target || (event.button > 0) || !event.isPrimary ) return;
    if ( target.disabled ) return;
    const press = this.#longPress = { target, x: event.clientX, y: event.clientY, fired: false };
    press.timer = setTimeout(() => {
      if ( this.#longPress !== press ) return;
      press.fired = true;
      try {
        if ( navigator.userActivation?.hasBeenActive ?? true ) navigator.vibrate?.(20);
      } catch(err) {}
      // Si el botón se volvió a dibujar mientras tanto, se usa el nuevo (mismos datos).
      const button = target.isConnected ? target : this.#findSameButton(target);
      try {
        // Aviso de salvación por chat de Midi: las tres opciones salen dentro del mismo aviso.
        if ( button?.matches(".bhd-save-alert-roll") ) {
          const modes = button.parentElement.querySelector(".bhd-save-alert-modes");
          if ( modes ) modes.hidden = false;
          button.hidden = true;
          useLog("Salvación por chat: toque largo, elige ventaja / normal / desventaja");
          return;
        }
        useLog("Toque largo: menú de opciones", { ...(button ?? target).dataset });
        this.#openChooser(button ?? target);
      } catch(err) {
        useError("Toque largo | No se pudo abrir el menú", err);
      }
    }, LONG_PRESS_MS);
  }

  /**
   * Si el dedo se mueve (el jugador está desplazando la lista), no es un toque largo.
   * @param {number} x
   * @param {number} y
   */
  #onPressMove(x, y) {
    const press = this.#longPress;
    if ( !press || press.fired ) return;
    if ( Math.hypot(x - press.x, y - press.y) > LONG_PRESS_TOLERANCE ) {
      clearTimeout(press.timer);
      this.#longPress = null;
    }
  }

  /** El dedo se levantó: si el toque largo ya abrió el menú, el clic que viene ahora se descarta. */
  #endPress() {
    const press = this.#longPress;
    if ( !press ) return;
    clearTimeout(press.timer);
    if ( press.fired ) this.#suppressClickUntil = Date.now() + LONG_PRESS_CLICK_GUARD;
    else this.#longPress = null;
  }

  /**
   * El mismo botón tras volver a dibujar la vista (busca por sus datos).
   * @param {HTMLElement} old
   * @returns {HTMLElement|null}
   */
  #findSameButton(old) {
    const keys = ["action", "kind", "itemId", "activityId", "type", "key", "hudBlock"];
    return [...(this.element?.querySelectorAll(LONG_PRESS_SELECTOR) ?? [])].find(el =>
      keys.every(k => el.dataset[k] === old.dataset[k])) ?? null;
  }

  /**
   * Menú del toque largo: en Ataque, ventaja / normal / desventaja (y las ventanas de dnd5e para
   * opciones raras, como la munición o el modo de ataque); en Daño, normal o crítico.
   * @param {HTMLElement} button  Botón tocado (con data-kind, data-item-id, data-activity-id).
   */
  #openChooser(button) {
    if ( button.matches(".bhd-rollable") ) return this.#openCheckChooser(button);
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
    const adv = `
        ${option("advantage", "fa-solid fa-angles-up", "BHD.Actions.Advantage", "bhd-mode bhd-mode-adv")}
        ${option("normal", "fa-solid fa-dice-d20", "BHD.Actions.Normal", "bhd-mode")}
        ${option("disadvantage", "fa-solid fa-angles-down", "BHD.Actions.Disadvantage", "bhd-mode bhd-mode-dis")}`;
    let modes;
    let slots = "";
    if ( kind === "midi" ) {
      // Con Midi: ventaja / desventaja si es un ataque, y el nivel del hechizo (si hay más de uno para elegir).
      const activity = item.system.activities?.get(activityId);
      const verb = (item.type === "spell") ? "Cast" : ((activity?.type === "attack") ? "Attack" : "Use");
      modes = (activity?.type === "attack") ? adv
        : option("normal", "fa-solid fa-hand-sparkles", `BHD.Midi.${verb}`, "bhd-mode bhd-mode-single");
      const options = getSlotOptions(activity);
      if ( options?.length > 1 ) {
        const current = this.#quick.getSlot(activity);
        const escape = foundry.utils.escapeHTML;
        slots = `
        <h4 class="bhd-chooser-heading">${escape(game.i18n.localize("BHD.Actions.SlotChoose"))}</h4>
        <div class="bhd-chooser-slots">${options.map(o => `
          <button type="button" class="bhd-slot-chip ${o.value === current ? "bhd-on" : ""}" data-action="bhdChooseSlot"
                  data-item-id="${itemId}" data-slot="${escape(o.value)}" aria-pressed="${o.value === current}" ${o.disabled ? "disabled" : ""}>
            ${escape(o.label)}
          </button>`).join("")}
        </div>`;
      }
    }
    else modes = (kind === "attack") ? adv : `
        ${option("normal", "fa-solid fa-droplet", "BHD.Actions.NormalDamage", "bhd-mode")}
        ${option("critical", "fa-solid fa-burst", "BHD.Actions.CriticalDamage", "bhd-mode bhd-mode-crit")}`;
    chooser.innerHTML = `
      <div class="bhd-chooser-backdrop" data-action="closeChooser"></div>
      <section class="bhd-chooser-sheet" role="dialog" aria-modal="true">
        <header class="bhd-chooser-header"><img src="" alt=""><span class="bhd-chooser-name"></span></header>
        ${slots}
        <div class="bhd-chooser-modes">${modes}</div>
        ${(kind === "attack") ? option("full", "fa-solid fa-sliders", "BHD.Actions.MoreOptions", "bhd-chooser-more") : ""}
        <button type="button" class="bhd-chooser-cancel" data-action="closeChooser">${game.i18n.localize("BHD.Actions.Cancel")}</button>
      </section>`;
    chooser.querySelector(".bhd-chooser-header img").src = item.img;
    chooser.querySelector(".bhd-chooser-name").textContent = item.name;
    chooser.hidden = false;
  }

  /**
   * Lista para encantar desde una tarjeta (arma de pacto...): lo ya encantado (con Quitar) y los objetos del
   * personaje que dnd5e deja encantar. Usa la misma hoja inferior que el menú del toque largo.
   * @param {ChatMessage} message  Tarjeta de la actividad de encantar.
   */
  #openEnchantPicker(message) {
    const chooser = this.element?.querySelector(".bhd-chooser");
    const data = prepareEnchantPicker(message);
    if ( !chooser || !data ) return;
    const escape = foundry.utils.escapeHTML;
    const localize = key => escape(game.i18n.localize(key));
    const entry = (entry, action, icon, cssClass) => `
      <button type="button" class="bhd-mode bhd-enchant-entry ${cssClass}" data-action="${action}"
              data-message-id="${message.id}" ${action === "bhdEnchantPick" ? `data-item-id="${entry.id}"` : `data-uuid="${escape(entry.uuid)}"`}>
        <img src="${escape(entry.img ?? "")}" alt=""><span>${escape(entry.name)}</span>
        <i class="${icon}" aria-hidden="true"></i>
      </button>`;
    const applied = data.applied.map(a => a.removable ? entry(a, "bhdEnchantRemove", "fa-solid fa-rotate-left", "bhd-enchant-applied")
      : `<p class="bhd-enchant-applied"><img src="${escape(a.img ?? "")}" alt=""> ${escape(a.name)}</p>`).join("");
    let choose = "";
    if ( data.concentrationEnded ) choose = `<p class="bhd-enchant-note">${localize("DND5E.ENCHANT.Warning.ConcentrationEnded")}</p>`;
    else if ( data.full ) choose = `<p class="bhd-enchant-note">${localize("BHD.Enchant.Full")}</p>`;
    else if ( data.candidates.length ) choose = data.candidates.map(c => entry(c, "bhdEnchantPick", "fa-solid fa-wand-sparkles", "")).join("");
    else choose = `<p class="bhd-enchant-note">${localize("BHD.Enchant.NoItems")}</p>`;
    const count = data.max ? ` <span class="bhd-count">${data.applied.length}/${data.max}</span>` : "";
    chooser.innerHTML = `
      <div class="bhd-chooser-backdrop" data-action="closeChooser"></div>
      <section class="bhd-chooser-sheet bhd-enchant-picker" role="dialog" aria-modal="true">
        <header class="bhd-chooser-header"><img src="${escape(data.img)}" alt=""><span class="bhd-chooser-name">${escape(data.title)}</span></header>
        ${data.applied.length ? `<h4 class="bhd-enchant-heading">${localize("BHD.Enchant.Applied")}${count}</h4>
        <div class="bhd-enchant-list">${applied}</div>` : ""}
        <h4 class="bhd-enchant-heading">${localize("BHD.Enchant.Choose")}${data.applied.length ? "" : count}</h4>
        <div class="bhd-enchant-list">${choose}</div>
        <button type="button" class="bhd-chooser-cancel" data-action="closeChooser">${localize("BHD.Actions.Close")}</button>
      </section>`;
    chooser.hidden = false;
  }

  /**
   * Menú del toque largo en una característica, salvación, habilidad o salvación de muerte:
   * ventaja / normal / desventaja.
   * @param {HTMLElement} button  Botón con data-type, data-key y data-label.
   */
  #openCheckChooser(button) {
    const chooser = this.element.querySelector(".bhd-chooser");
    const actor = this.actor;
    if ( !chooser || !actor ) return;
    const escape = foundry.utils.escapeHTML;
    const { type, key, label } = button.dataset;
    const data = `data-type="${escape(type ?? "")}" data-key="${escape(key ?? "")}" data-label="${escape(label ?? "")}"`;
    const option = (mode, icon, text, cssClass) => `
      <button type="button" class="${cssClass}" data-action="bhdCheckMode" data-mode="${mode}" ${data}>
        <i class="${icon}" aria-hidden="true"></i><span>${escape(game.i18n.localize(text))}</span>
      </button>`;
    chooser.innerHTML = `
      <div class="bhd-chooser-backdrop" data-action="closeChooser"></div>
      <section class="bhd-chooser-sheet" role="dialog" aria-modal="true">
        <header class="bhd-chooser-header"><img src="${escape(actor.img ?? "")}" alt=""><span class="bhd-chooser-name">${escape(label ?? "")}</span></header>
        <div class="bhd-chooser-modes">
          ${option("advantage", "fa-solid fa-angles-up", "BHD.Actions.Advantage", "bhd-mode bhd-mode-adv")}
          ${option("normal", "fa-solid fa-dice-d20", "BHD.Actions.Normal", "bhd-mode")}
          ${option("disadvantage", "fa-solid fa-angles-down", "BHD.Actions.Disadvantage", "bhd-mode bhd-mode-dis")}
        </div>
        <button type="button" class="bhd-chooser-cancel" data-action="closeChooser">${escape(game.i18n.localize("BHD.Actions.Cancel"))}</button>
      </section>`;
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
    if ( this.#busy.isBusy("use") ) {
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
    const lock = this.#busy.acquire("use", { button, label: item.name });
    if ( !lock ) return;
    this.#prepareTray(item);
    try {
      useLog(`${tag} | Toque`, { mode, targets: Array.from(game.user.targets).map(t => t.name) });

      // Los objetos sin actividades son pasivos: no tienen botones (la fila solo muestra su descripción).
      if ( !activity ) return;

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
        cast = await this.#cast(item, activity, kind, event, tag);
        if ( !cast ) return;
      }

      // Las tiradas de un lanzamiento cuelgan de su tarjeta y usan el nivel del espacio gastado.
      const rollActivity = getScaledActivity(activity, cast?.scaling ?? 0);
      const message = cast?.messageId ? { data: getOriginMessageData(cast.messageId) } : {};
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
      const late = lock.timedOut;
      this.#busy.release(lock);
      if ( late ) useLog(`${tag} | Terminó tarde (el botón ya estaba libre)`);
      this.#renderRows();
    }
  }

  /**
   * Con Midi QOL: el botón principal de la fila (Atacar, Lanzar o Usar). El teléfono no ejecuta nada: elige
   * los objetivos (si la actividad los necesita), manda la petición al DM y muestra lo que el DM devuelve
   * (impacta o falla, crítico, daño). La tarjeta de Midi se ve en el panel de resultados.
   * @param {Item} item
   * @param {Activity} activity
   * @param {object} [options]
   * @param {string} [options.mode="normal"]  "normal", "advantage" o "disadvantage".
   * @param {HTMLElement} [options.button]
   * @param {string} [options.hudBlock]       Bloque del HUD de combate (para marcar lo usado en el turno).
   */
  async #runMidi(item, activity, { mode="normal", button, hudBlock }={}) {
    if ( !this.actor || (item.actor !== this.actor) || !activity ) return;
    if ( this.#busy.isBusy("use") || this.#midiPending.has(item.id) ) {
      ui.notifications.info(game.i18n.format("BHD.Use.Busy", { name: item.name }));
      return;
    }
    const tag = `${item.name} (Midi)`;
    const blocked = getRemoteBlock();
    if ( blocked ) {
      useWarn(`${tag} | No se puede pedir al DM: ${blocked}`);
      ui.notifications.warn(game.i18n.format(`BHD.Midi.Reason.${blocked}`, { name: item.name }));
      return;
    }

    // Área (Fireball, Burning Hands...): el jugador la coloca antes de que empiece el uso; si cancela, no se
    // pide nada al DM y no se gasta nada. Objetivos: los elige el jugador aquí; con área o sobre uno mismo, ninguno.
    const slot = this.#quick.getSlot(activity);
    let targetIds = [];
    let template = null;
    let summon = null;
    if ( needsAreaPlacement(activity) ) {
      template = await this.#placeArea(item, activity, slot);
      if ( !template ) return;
    } else if ( needsSummonPlacement(activity) ) {
      // Invocar: el jugador elige y coloca las criaturas antes (si cancela, no se gasta nada).
      summon = await this.#placeSummons(item, activity, slot);
      if ( !summon ) return;
    } else {
      const need = getTargetNeed([activity]);
      if ( need ) {
        const ids = await this.#pickTargets({ title: item.name, img: item.img, max: need.max });
        if ( ids === null ) return;
        setTargets(ids);
        targetIds = getTargetIds();
      }
    }
    const block = (hudBlock === "opportunity") ? "reaction" : (hudBlock ?? activity.activation?.type);

    // El botón se libera como mucho a los 10 s; el uso sigue en el PC del DM y su resultado se enseña al llegar.
    // Mientras tanto, ese mismo objeto no se vuelve a pedir (no se gasta dos veces).
    const lock = this.#busy.acquire("use", { button, label: item.name });
    if ( !lock ) return;
    lock.midi = true;
    this.#midiPending.add(item.id);
    this.#prepareTray(item);
    this.#showWaiting(item);
    try {
      useLog(`${tag} | 1. Petición al DM`, {
        activity: activity.name, type: activity.type, mode, slot,
        targets: targetIds.map(id => game.scenes.active?.tokens.get(id)?.name ?? id)
      });
      const result = await requestMidiUse(activity, { targetIds, slot, mode, template, summon });
      this.#hideToast();
      if ( !result?.ok ) {
        useWarn(`${tag} | 2. El DM no lo usó: ${result?.reason}`, result?.error ?? "", result?.notices ?? []);
        // Lo que dnd5e o Midi avisaron en el PC del DM ("no quedan usos"...) es el motivo real: se enseña aquí.
        if ( result?.notices?.length ) result.notices.forEach(text => ui.notifications.warn(text));
        else ui.notifications.warn(game.i18n.format(`BHD.Midi.Reason.${result?.reason ?? "Error"}`, {
          name: item.name, error: result?.error ?? ""
        }));
        return;
      }
      useLog(`${tag} | 2. Resultado del DM`, result);
      this.#markUsed(block);
      if ( result.messageId ) this.#openTrayById(result.messageId);
      // Encantar (Shillelagh, Repelling Blast, arma del pacto...): el DM hizo el uso; qué objeto se encanta lo elige
      // el jugador aquí, con la lista de dnd5e (lo mismo que soltar el objeto en la tarjeta).
      if ( (activity.type === "enchant") && !activity.enchant?.self && result.messageId ) {
        this.#openEnchantWhenReady(result.messageId, tag);
      }
      this.#showMidiResult(item, result);
      if ( hudBlock ) this.#hudResult = this.#toHudResult(item, result);
    } catch(err) {
      this.#hideToast();
      useError(`${tag} | Error`, err);
      ui.notifications.error(game.i18n.format("BHD.Use.Error", { name: item.name, error: err?.message ?? String(err) }));
    } finally {
      this.#midiPending.delete(item.id);
      this.#busy.release(lock);
      this.#renderRows();
    }
  }

  /**
   * Abre la lista de encantar de una tarjeta que hizo el DM, en cuanto la tarjeta llega a este teléfono (5 s máx.).
   * @param {string} messageId
   * @param {string} tag  Para el registro.
   */
  async #openEnchantWhenReady(messageId, tag) {
    let message = game.messages.get(messageId);
    for ( let waited = 0; !message && (waited < 5000); waited += 250 ) {
      await new Promise(resolve => setTimeout(resolve, 250));
      message = game.messages.get(messageId);
    }
    if ( !message ) {
      useWarn(`${tag} | La tarjeta de encantar no llegó; usa "Elegir objeto" en el panel`);
      return;
    }
    if ( !message.getFlag("dnd5e", "use.enchantmentProfile") ) {
      useLog(`${tag} | La tarjeta no trae encantamiento elegido (dnd5e no pide objeto)`);
      return;
    }
    useLog(`${tag} | 3. Elegir el objeto que se encanta`);
    this.#openEnchantPicker(message);
  }

  /**
   * "Colocar área": el DM enseña la vista previa en la TV y el jugador la mueve desde aquí.
   * @param {Item} item
   * @param {Activity} activity
   * @param {string|null} slot
   * @returns {Promise<{x: number, y: number, direction: number}|null>}  Null si cancela o no se pudo.
   */
  async #placeArea(item, activity, slot) {
    const tag = `${item.name} (área)`;
    useLog(`${tag} | 1. Pedir vista previa al DM`, { slot });
    const start = await requestPlacementStart(activity, slot);
    if ( !start?.ok ) {
      useWarn(`${tag} | No se pudo empezar: ${start?.reason}`, start?.error ?? "");
      this.#warnPlaceReason(start?.reason, item, start?.error);
      return null;
    }
    const panel = this.element.querySelector(".bhd-place");
    if ( !panel ) return null;
    return new Promise(resolve => {
      const api = {
        kind: "area",
        move: (id, change) => requestPlacementMove(id, change),
        // Confirmar devuelve la posición; el área no tiene más pasos.
        end: async (id, confirm) => {
          const result = await requestPlacementEnd(id, confirm);
          if ( !confirm ) return result;
          if ( !result?.ok || !Number.isFinite(result.x) ) return { ok: false, reason: result?.reason ?? "Expired", error: result?.error };
          return { ok: true, done: true, value: { x: result.x, y: result.y, direction: result.direction } };
        }
      };
      this.#place = { sessionId: start.sessionId, item, state: start, busy: false, resolve, api };
      // Si el jugador tarda, el DM puede colocarla él: la posición llega aquí.
      waitForGmPlacement(start.sessionId, data => {
        useLog(`${tag} | 2. La colocó el DM`, data);
        ui.notifications.info(game.i18n.format("BHD.Place.GMPlaced", { name: item.name }));
        this.#finishPlace({ x: data.x, y: data.y, direction: data.direction });
      });
      this.#renderPlace(true);
    });
  }

  /**
   * "Colocar criaturas" (actividad Invocar de dnd5e): elegir la criatura si hay varias y colocarlas una a una con
   * la cruceta, antes del uso (si cancela, no se pide nada y no se gasta nada).
   * @param {Item} item
   * @param {Activity} activity
   * @param {string|null} slot
   * @returns {Promise<object|null>}  `{ profile, creatureSize, creatureType, placements }` o null si cancela.
   */
  async #placeSummons(item, activity, slot) {
    const tag = `${item.name} (invocar)`;
    const choice = await chooseSummonOptions(activity);
    if ( !choice ) {
      useLog(`${tag} | Cancelado al elegir la criatura: no se usa nada`);
      return null;
    }
    useLog(`${tag} | 1. Pedir vista previa al DM`, { slot, ...choice });
    const start = await requestSummonStart(activity, slot, choice);
    if ( !start?.ok ) {
      useWarn(`${tag} | No se pudo empezar: ${start?.reason}`, start?.error ?? "");
      this.#warnPlaceReason(start?.reason, item, start?.error);
      return null;
    }
    const placements = await this.#openTokenPlace(start.sessionId, { name: item.name, img: item.img }, start);
    if ( !placements ) return null;
    useLog(`${tag} | 2. Colocadas ${placements.length}`, placements);
    return { ...choice, placements };
  }

  /**
   * Abre la cruceta para colocar criaturas de una sesión del DM (una tras otra).
   * @param {string} sessionId
   * @param {{name: string, img: string}} item
   * @param {object} state
   * @returns {Promise<object[]|null>}  Las posiciones, o null si cancela.
   */
  #openTokenPlace(sessionId, item, state) {
    if ( this.#place ) this.#finishPlace(null);
    const panel = this.element?.querySelector(".bhd-place");
    if ( !panel ) return Promise.resolve(null);
    return new Promise(resolve => {
      const api = {
        kind: "token",
        move: (id, change) => requestSummonMove(id, change),
        end: async (id, confirm) => {
          const result = await requestSummonEnd(id, confirm);
          if ( !confirm || !result?.ok ) return result;
          if ( result.done ) return { ok: true, done: true, value: result.placements ?? null };
          return { ...result, ok: true, done: false };
        }
      };
      this.#place = { sessionId, item, state, busy: false, resolve, api };
      this.#renderPlace(true);
    });
  }

  /**
   * El DM pide colocar algo de Cauldron (invocación, teletransporte) durante un uso (summon-placement.js).
   * @param {{sessionId: string, title: string, img: string, state: object}} data
   * @returns {Promise<{ok: boolean, cancelled?: boolean}>}
   */
  async placeFromGM(data) {
    useLog(`Colocar (Cauldron): ${data.title}`, data.state);
    try {
      if ( navigator.userActivation?.hasBeenActive ?? true ) navigator.vibrate?.([200, 80, 200]);
    } catch(err) {}
    const placements = await this.#openTokenPlace(data.sessionId, { name: data.title, img: data.img }, data.state);
    return placements?.length ? { ok: true, ...placements[0] } : { ok: true, cancelled: true };
  }

  /**
   * Aviso de por qué no se pudo colocar el área.
   * @param {string} reason
   * @param {Item} item
   * @param {string} [error]
   */
  #warnPlaceReason(reason, item, error="") {
    const own = ["NoToken", "NoArea", "Expired", "NoCreature"].includes(reason);
    const key = own ? `BHD.Place.Reason.${reason}` : `BHD.Midi.Reason.${reason ?? "Error"}`;
    ui.notifications.warn(game.i18n.format(key, { name: item.name, error }));
  }

  /**
   * Dibuja el panel "Colocar área" (la primera vez entero; luego solo lo que cambia: quién queda dentro).
   * @param {boolean} [full]
   */
  #renderPlace(full=false) {
    const panel = this.element?.querySelector(".bhd-place");
    const place = this.#place;
    if ( !panel || !place ) return;
    const escape = foundry.utils.escapeHTML;
    const localize = key => escape(game.i18n.localize(key));
    const state = place.state;
    if ( full ) {
      const arrows = [
        [-1, -1, "fa-arrow-up-left", "NW"], [0, -1, "fa-arrow-up", "N"], [1, -1, "fa-arrow-up-right", "NE"],
        [-1, 0, "fa-arrow-left", "W"], null, [1, 0, "fa-arrow-right", "E"],
        [-1, 1, "fa-arrow-down-left", "SW"], [0, 1, "fa-arrow-down", "S"], [1, 1, "fa-arrow-down-right", "SE"]
      ].map(arrow => arrow ? `
        <button type="button" class="bhd-place-arrow" data-dx="${arrow[0]}" data-dy="${arrow[1]}"
                aria-label="${localize(`BHD.Place.Dir.${arrow[3]}`)}"><i class="fa-solid ${arrow[2]}" aria-hidden="true"></i></button>`
        : `<span class="bhd-place-center"><i class="fa-solid fa-crosshairs" aria-hidden="true"></i></span>`).join("");
      const rotate = state.canRotate ? `
        <div class="bhd-place-rotate">
          <button type="button" data-action="bhdPlaceRotate" data-deg="${-ROTATE_STEP}" aria-label="${localize("BHD.Place.RotateLeft")}">
            <i class="fa-solid fa-rotate-left" aria-hidden="true"></i> ${localize("BHD.Place.RotateLeft")}</button>
          <button type="button" data-action="bhdPlaceRotate" data-deg="${ROTATE_STEP}" aria-label="${localize("BHD.Place.RotateRight")}">
            ${localize("BHD.Place.RotateRight")} <i class="fa-solid fa-rotate-right" aria-hidden="true"></i></button>
        </div>` : "";
      panel.innerHTML = `
        <div class="bhd-chooser-backdrop"></div>
        <section class="bhd-place-sheet" role="dialog" aria-modal="true">
          <header class="bhd-chooser-header">
            <img class="bhd-place-img" src="${escape(place.item.img)}" alt="">
            <span class="bhd-chooser-name">${localize(place.api?.kind === "token" ? "BHD.Summon.Title" : "BHD.Place.Title")}:
              <span class="bhd-place-name">${escape(place.item.name)}</span></span>
          </header>
          ${state.range ? `<p class="bhd-place-range">${escape(game.i18n.format("BHD.Place.Range", { range: state.range }))}</p>` : ""}
          <div class="bhd-place-inside" aria-live="polite"></div>
          <p class="bhd-place-msg" hidden></p>
          ${state.canMove ? `<div class="bhd-place-pad">${arrows}</div>` : `<p class="bhd-place-self">${localize("BHD.Place.SelfHint")}</p>`}
          ${rotate}
          <div class="bhd-place-actions">
            <button type="button" class="bhd-place-cancel" data-action="bhdPlaceCancel">
              <i class="fa-solid fa-xmark" aria-hidden="true"></i> ${localize("BHD.Place.Cancel")}</button>
            <button type="button" class="bhd-big-btn bhd-place-confirm" data-action="bhdPlaceConfirm">
              <i class="fa-solid fa-check" aria-hidden="true"></i> ${localize("BHD.Place.Confirm")}</button>
          </div>
        </section>`;
      panel.hidden = false;
    }

    // Criaturas: cuál se coloca (1 de 3), a qué distancia y si la casilla está ocupada.
    if ( place.api?.kind === "token" ) {
      const insideEl = panel.querySelector(".bhd-place-inside");
      const img = panel.querySelector(".bhd-place-img");
      if ( img && state.img ) img.src = state.img;
      if ( insideEl ) {
        const which = (state.count > 1)
          ? escape(game.i18n.format("BHD.Summon.Which", { n: (state.index ?? 0) + 1, count: state.count, name: state.name ?? "" }))
          : escape(state.name ?? "");
        insideEl.innerHTML = `<strong>${which}</strong>
          <span class="bhd-place-distance">${escape(game.i18n.format("BHD.Summon.Distance", { distance: state.distance ?? "" }))}</span>
          ${state.occupied ? `<span class="bhd-place-occupied">${localize("BHD.Summon.Occupied")}</span>` : ""}`;
      }
      const confirm = panel.querySelector(".bhd-place-confirm");
      if ( confirm ) confirm.classList.toggle("bhd-disabled-look", !!state.occupied);
      return;
    }

    // Quién queda dentro (aliados y enemigos), según el DM.
    const sides ={ ally: "BHD.Place.Ally", enemy: "BHD.Place.Enemy", neutral: "BHD.Place.Neutral", self: "BHD.Place.Self", unknown: "BHD.Place.Unknown" };
    const inside = state.inside ?? [];
    const chips = inside.map(c => `<li class="bhd-place-chip bhd-side-${c.side}">
      ${escape(c.name || game.i18n.localize("BHD.Place.UnknownCreature"))} <small>${localize(sides[c.side] ?? sides.neutral)}</small></li>`).join("");
    const insideEl = panel.querySelector(".bhd-place-inside");
    if ( insideEl ) insideEl.innerHTML = inside.length
      ? `<strong>${escape(game.i18n.format("BHD.Place.Inside", { n: inside.length }))}</strong><ul>${chips}</ul>`
      : `<strong>${localize("BHD.Place.Nobody")}</strong>`;
  }

  /**
   * Mueve o gira la vista previa (una petición a la vez). Si choca con el alcance o el borde, vibra y avisa.
   * @param {{dx?: number, dy?: number, rotate?: number}} change
   * @returns {Promise<boolean>}  false si no se movió (para parar el movimiento rápido).
   */
  async #placeStep(change) {
    const place = this.#place;
    if ( !place || place.busy ) return true;
    place.busy = true;
    try {
      const result = await place.api.move(place.sessionId, change);
      if ( this.#place !== place ) return false;
      if ( !result?.ok ) {
        useWarn(`${place.item.name} (colocar) | Error al mover: ${result?.reason}`, result?.error ?? "");
        this.#warnPlaceReason(result?.reason, place.item, result?.error);
        if ( result?.reason === "Expired" ) this.#finishPlace(null);
        return false;
      }
      place.state = result;
      this.#renderPlace();
      const message = this.element.querySelector(".bhd-place-msg");
      if ( message ) message.hidden = !result.blocked;
      if ( result.blocked ) {
        this.#placeBump(result.blockReason);
        return false;
      }
      return true;
    } finally {
      place.busy = false;
    }
  }

  /**
   * Choque al colocar (alcance, pared, borde, casilla ocupada): mensaje, vibración y temblor de la cruceta.
   * @param {string} [reason]  "Range", "Wall", "Edge", "Occupied" (sin motivo: fuera de alcance, como las áreas).
   */
  #placeBump(reason) {
    const message = this.element?.querySelector(".bhd-place-msg");
    const keys = { Wall: "BHD.Summon.Wall", Edge: "BHD.Summon.Edge", Occupied: "BHD.Summon.Occupied" };
    if ( message ) {
      message.textContent = game.i18n.localize(keys[reason] ?? "BHD.Place.OutOfRange");
      message.hidden = false;
    }
    useLog(`Colocar: choque (${reason ?? "Range"})`);
    try {
      if ( navigator.userActivation?.hasBeenActive ?? true ) navigator.vibrate?.([60, 40, 60]);
    } catch(err) {}
    const pad = this.element?.querySelector(".bhd-place-pad");
    if ( pad ) {
      pad.classList.remove("bhd-shake");
      void pad.offsetWidth;
      pad.classList.add("bhd-shake");
    }
  }

  /**
   * Flecha pulsada: una casilla al momento y, si se mantiene, una tras otra hasta soltarla o chocar.
   * @param {HTMLElement} arrow
   */
  async #startPlaceHold(arrow) {
    const change = { dx: Number(arrow.dataset.dx), dy: Number(arrow.dataset.dy) };
    const hold = this.#placeHold = { active: true };
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    navigator.vibrate?.(10);
    if ( !await this.#placeStep(change) ) return;
    await sleep(380);
    while ( hold.active && (this.#placeHold === hold) && this.#place ) {
      if ( !await this.#placeStep(change) ) break;
      await sleep(70);
    }
  }

  /**
   * Termina la colocación y devuelve el resultado a quien la pidió.
   * @param {{x: number, y: number, direction: number}|null} result
   */
  #finishPlace(result) {
    const place = this.#place;
    this.#place = null;
    if ( this.#placeHold ) this.#placeHold.active = false;
    waitForGmPlacement(null);
    const panel = this.element?.querySelector(".bhd-place");
    if ( panel ) panel.hidden = true;
    place?.resolve(result);
  }

  /**
   * Aviso "Esperando al DM…" mientras el DM ejecuta el uso (no se quita solo).
   * @param {Item} item
   */
  #showWaiting(item) {
    const toast = this.element.querySelector(".bhd-toast");
    if ( !toast ) return;
    clearTimeout(this.#toastTimeout);
    toast.classList.remove("bhd-crit", "bhd-fumble");
    toast.innerHTML = `<span class="bhd-toast-label"></span>
      <span class="bhd-toast-total bhd-toast-wait"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i></span>`;
    toast.querySelector(".bhd-toast-label").textContent = game.i18n.format("BHD.Midi.Waiting", { name: item.name });
    toast.hidden = false;
  }

  /** Quita el aviso de tirada (o el de espera). */
  #hideToast() {
    clearTimeout(this.#toastTimeout);
    const toast = this.element?.querySelector(".bhd-toast");
    if ( toast ) toast.hidden = true;
  }

  /**
   * Muestra el resultado de un uso hecho por el DM. Solo las partes que tiene el flujo de Midi de esa actividad:
   * ataque (total, crítico, pifia, impacta o falla a cada objetivo), salvación (quién salvó y quién no), daño o
   * curación aplicados a cada objetivo, y lo que gastó o recuperó. Impacta / falla solo con el ajuste del DM
   * "showAttackResult". Si no hay nada que enseñar, no se abre.
   * @param {Item} item
   * @param {object} result  Lo que devuelve el DM (midi-remote.js).
   */
  #showMidiResult(item, result) {
    const panel = this.element.querySelector(".bhd-midi-result");
    if ( !panel ) return;
    const escape = foundry.utils.escapeHTML;
    const localize = key => escape(game.i18n.localize(key));
    const attack = result.hasAttack ? result.attack : null;
    const tags = [];
    if ( attack?.critical ) tags.push(`<span class="bhd-midi-tag bhd-crit">${localize("BHD.Hud.Result.Critical")}</span>`);
    if ( attack?.fumble ) tags.push(`<span class="bhd-midi-tag bhd-fumble">${localize("BHD.Hud.Result.Fumble")}</span>`);

    const damageText = amount => {
      if ( !Number.isFinite(amount) ) return "";
      return (amount < 0) ? game.i18n.format("BHD.Midi.Healed", { n: -amount }) : game.i18n.format("BHD.Midi.Damage", { n: amount });
    };
    const rows = (result.targets ?? []).map(target => {
      const verdicts = [];
      if ( result.hasAttack && result.showHits && (target.hit !== null) ) {
        verdicts.push({ css: target.hit ? "bhd-good" : "bhd-bad", text: game.i18n.localize(target.hit ? "BHD.Hud.Result.Hit" : "BHD.Hud.Result.Miss") });
      }
      if ( result.hasSave && (target.saved !== null) ) {
        verdicts.push({ css: target.saved ? "bhd-bad" : "bhd-good", text: game.i18n.localize(target.saved ? "BHD.Midi.Saved" : "BHD.Midi.Failed") });
      }
      const damage = damageText(target.damage);
      if ( !verdicts.length && !damage ) return "";
      return `<li class="bhd-midi-target">
        <span class="bhd-midi-target-name">${escape(target.name)}</span>
        ${verdicts.map(v => `<strong class="bhd-midi-verdict ${v.css}">${escape(v.text)}</strong>`).join("")}
        ${damage ? `<span class="bhd-midi-damage">${escape(damage)}</span>` : ""}
      </li>`;
    }).join("");
    const consumed = (result.consumed ?? []).map(c => `<li><span>${escape(c.label)}</span> <strong>${escape(c.delta)}</strong></li>`).join("");
    if ( !attack && !rows && !consumed ) {
      panel.hidden = true;
      return;
    }

    panel.innerHTML = `
      <header class="bhd-midi-result-head">
        <img src="${escape(item.img)}" alt="">
        <strong class="bhd-midi-result-name">${escape(item.name)}</strong>
        ${tags.join("")}
        <button type="button" class="bhd-midi-result-close" data-action="bhdMidiResultClose" aria-label="${localize("BHD.Actions.Close")}">
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
      </header>
      ${attack ? `<p class="bhd-midi-attack"><i class="fa-solid fa-dice-d20" aria-hidden="true"></i>
        ${localize("BHD.Actions.Attack")}: <strong>${escape(String(attack.total ?? "?"))}</strong></p>` : ""}
      ${rows ? `<ul class="bhd-midi-targets">${rows}</ul>` : ""}
      ${consumed ? `<ul class="bhd-midi-consumed" aria-label="${localize("BHD.Midi.Consumed")}">${consumed}</ul>` : ""}`;
    panel.classList.toggle("bhd-crit", !!attack?.critical);
    panel.hidden = false;
    clearTimeout(this.#midiResultTimeout);
    this.#midiResultTimeout = setTimeout(() => panel.hidden = true, MIDI_RESULT_DURATION);
  }

  /**
   * El mismo resultado en el formato del HUD de combate.
   * @param {Item} item
   * @param {object} result
   * @returns {object}
   */
  #toHudResult(item, result) {
    const verdicts = (result.targets ?? []).filter(t => result.hasAttack && (t.hit !== null) && result.showHits).map(t => ({
      id: t.hit ? "hit" : "miss",
      name: t.name,
      label: game.i18n.localize(t.hit ? "BHD.Hud.Result.Hit" : "BHD.Hud.Result.Miss")
    }));
    const damage = (result.targets ?? []).reduce((sum, t) => sum + (Number.isFinite(t.damage) && (t.damage > 0) ? t.damage : 0), 0);
    return {
      itemId: item.id,
      name: item.name,
      img: item.img,
      attack: (result.hasAttack && result.attack)
        ? { total: result.attack.total, crit: result.attack.critical, fumble: result.attack.fumble } : null,
      verdicts,
      damage: damage ? { total: damage, label: game.i18n.localize("BHD.Actions.Damage") } : null,
      hint: null
    };
  }

  /**
   * Abre en el panel de resultados la tarjeta de un uso hecho por el DM (o espera a que llegue).
   * @param {string} messageId
   */
  #openTrayById(messageId) {
    const message = game.messages.get(messageId);
    if ( message ) this.#openTray(message);
    else this.#pendingTrayId = messageId;
  }

  /**
   * "Lanza" una actividad: `activity.use` sin ventana y sin tiradas automáticas (las hace cada botón).
   * dnd5e gasta el espacio elegido en la fila, los usos o la cantidad, empieza la concentración
   * (terminando la anterior si hace falta), coloca el área y crea la tarjeta del chat.
   * @param {Item} item
   * @param {Activity} activity
   * @param {string} kind  Botón tocado ("attack", "damage", "heal", "save", "use").
   * @param {Event} [event]
   * @param {string} tag  Prefijo del registro.
   * @returns {Promise<object|null>}  El lanzamiento, o null si no se pudo (dnd5e ya avisó por qué).
   */
  async #cast(item, activity, kind, event, tag) {
    const actor = item.actor;
    // Si el botón hace la tirada (Ataque, Daño, Curar), dnd5e no tira nada más; con Usar o Salvación hace lo
    // que la actividad haga después de usarse (p. ej. encantar el propio objeto).
    const usage = { event, subsequentActions: !ROLL_KINDS.has(kind) };
    const slot = this.#quick.getSlot(activity);
    if ( slot ) usage.spell = { slot };
    const concentrating = Array.from(actor.concentration?.effects ?? []).map(effect => ({
      id: effect.id,
      name: actor.items.get(effect.getFlag("dnd5e", "item")?.id)?.name ?? effect.name
    }));
    // Invocar (sin Midi): si hay DM, el jugador coloca las criaturas antes con la cruceta (vista previa en la TV).
    let summonChosen = false;
    if ( needsSummonPlacement(activity) && game.users.activeGM ) {
      const summon = await this.#placeSummons(item, activity, slot);
      if ( !summon ) return null;
      usage.summons = { profile: summon.profile, creatureSize: summon.creatureSize, creatureType: summon.creatureType };
      setLocalSummonPlacements(activity, summon.placements);
      summonChosen = true;
    }
    useLog(`${tag} | Lanzamiento`, { slot });
    let results;
    try {
      results = await activity.use(usage, { configure: needsUsageDialog(activity, { summonChosen }) }, {});
    } finally {
      setLocalSummonPlacements(null, null);
    }
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
    if ( message instanceof foundry.documents.ChatMessage ) {
      this.#openTray(message);
      // La tarjeta pide elegir un objeto (encantar: arma de pacto...): en el chat se arrastra; aquí, una lista.
      if ( message.getFlag("dnd5e", "use.enchantmentProfile") && !activity.enchant?.self ) {
        this.#openEnchantPicker(message);
      }
    }
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
    const lock = this.#busy.acquire("use", { label: item.name });
    if ( !lock ) {
      ui.notifications.info(game.i18n.format("BHD.Use.Busy", { name: item.name }));
      return;
    }
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
      this.#busy.release(lock);
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
    const itemId = getMessageItemId(message);
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
    // Zonas de "arrastra aquí el objeto" de las tarjetas de encantar: en el teléfono, un botón que abre la lista.
    for ( const zone of log.querySelectorAll("enchantment-application") ) {
      const messageId = zone.closest("[data-message-id]")?.dataset.messageId;
      if ( !messageId || zone.querySelector(".bhd-enchant-open") ) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "bhd-enchant-open";
      button.dataset.action = "bhdEnchantOpen";
      button.dataset.messageId = messageId;
      button.innerHTML = `<i class="fa-solid fa-hand-pointer" aria-hidden="true"></i> ${foundry.utils.escapeHTML(game.i18n.localize("BHD.Enchant.Open"))}`;
      zone.append(button);
    }
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

    // Tarjeta de Midi de un uso que hizo el DM: llegó después de su resultado.
    if ( (action === "create") && (message.id === this.#pendingTrayId) ) {
      this.#pendingTrayId = null;
      this.#openTray(message);
      return;
    }
    if ( !this.#trayItemId ) return;
    if ( action === "create" ) {
      const origin = getOriginMessageId(message);
      const ownRoll = message.isAuthor && (getMessageItemId(message) === this.#trayItemId)
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
      if ( !this.#busy.isBusy("use") ) this.#renderRows();
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
    if ( !this.#busy.isBusy("use") ) this.#renderRows();
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
    for ( const prompt of findSavePrompts(message, this.actor, { midi: isMidiActive() }) ) {
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
    const actor = prompt?.actor ?? this.actor;
    if ( !alert ) return;
    if ( !prompt || !actor ) {
      alert.hidden = true;
      dequeuePrompt(this.#saveEntry);
      this.#saveEntry = null;
      this.#tickSaveAlert();
      return;
    }
    // Una sola pregunta a la vez: el aviso de salvación tiene su sitio en la cola única (con la cuenta atrás de
    // la primera salvación, si tiene).
    const deadline = prompt.endsAt ?? prompt.deadline ?? null;
    if ( !this.#saveEntry ) this.#saveEntry = enqueuePrompt({ kind: "save", label: prompt.type ?? "", deadline });
    else setPromptDeadline(this.#saveEntry, deadline);
    const localize = key => game.i18n.localize(key);
    const concentration = prompt.type === "concentration";
    const title = concentration ? "BHD.Save.ConcentrationTitle"
      : (["check", "skill", "tool"].includes(prompt.type) ? "BHD.Save.CheckTitle" : "BHD.Save.Title");
    const more = this.#savePrompts.length - 1;
    // Midi espera la tirada: no hay "Ahora no" (si Midi tiene tiempo límite, se tira sola al acabarse).
    let later;
    if ( prompt.midiChat ) later = `
        ${prompt.endsAt ? `<div class="bhd-reaction-timer"><span class="bhd-reaction-bar bhd-save-alert-bar"></span></div>
        <span class="bhd-save-alert-more bhd-save-alert-seconds"></span>` : ""}
        <div class="bhd-save-alert-modes" hidden>
          <span class="bhd-save-alert-more">${localize("BHD.Save.ChooseMode")}</span>
          <button type="button" class="bhd-big-btn bhd-save-mode bhd-mode-adv" data-action="bhdSaveMode" data-mode="advantage">
            <i class="fa-solid fa-angles-up" aria-hidden="true"></i> ${localize("BHD.Actions.Advantage")}</button>
          <button type="button" class="bhd-big-btn bhd-save-mode" data-action="bhdSaveMode" data-mode="normal">
            <i class="fa-solid fa-dice-d20" aria-hidden="true"></i> ${localize("BHD.Actions.Normal")}</button>
          <button type="button" class="bhd-big-btn bhd-save-mode bhd-mode-dis" data-action="bhdSaveMode" data-mode="disadvantage">
            <i class="fa-solid fa-angles-down" aria-hidden="true"></i> ${localize("BHD.Actions.Disadvantage")}</button>
        </div>
        <span class="bhd-save-alert-hint">${localize("BHD.Save.HoldForMode")}</span>`;
    else if ( prompt.midi ) later = prompt.timeout
      ? `<span class="bhd-save-alert-more">${game.i18n.format("BHD.Save.AutoRoll", { seconds: prompt.timeout })}</span>` : "";
    else later = `<button type="button" class="bhd-save-alert-later" data-action="bhdSaveDismiss">${localize("BHD.Save.Later")}</button>`;
    // Ventaja / desventaja que calculó Midi (condiciones, efectos, rasgos): se ve en el botón.
    const modeKey = (prompt.advantage && !prompt.disadvantage) ? "BHD.Save.Advantage"
      : ((prompt.disadvantage && !prompt.advantage) ? "BHD.Save.Disadvantage" : null);
    const modeClass = modeKey ? (prompt.advantage ? "bhd-save-adv" : "bhd-save-dis") : "";
    alert.innerHTML = `
      <div class="bhd-save-alert-box ${concentration ? "bhd-save-concentration" : ""}">
        <i class="fa-solid ${concentration ? "fa-brain" : "fa-shield-heart"} bhd-save-alert-icon" aria-hidden="true"></i>
        <strong class="bhd-save-alert-title">${localize(title)}</strong>
        <span class="bhd-save-alert-source"></span>
        <button type="button" class="bhd-big-btn bhd-save-alert-roll ${modeClass}" data-action="bhdSaveRoll"
                ${prompt.midiChat ? "data-midi-chat" : ""}>
          <i class="fa-solid fa-dice-d20" aria-hidden="true"></i> <span class="bhd-save-alert-label"></span>
          ${modeKey ? `<em class="bhd-save-alert-mode">${localize(modeKey)}</em>` : ""}
        </button>
        ${later}
        ${more > 0 ? `<span class="bhd-save-alert-more">${game.i18n.format("BHD.Save.More", { count: more })}</span>` : ""}
      </div>`;
    const what = [(actor !== this.actor) ? actor.name : "", prompt.source].filter(_ => _).join(" · ");
    let source = what ? game.i18n.format("BHD.Save.From", { source: what }) : "";
    if ( prompt.midiChat && prompt.caster ) {
      source = game.i18n.format("BHD.Save.FromCaster", { source: what || "—", caster: prompt.caster });
    }
    alert.querySelector(".bhd-save-alert-source").textContent = source;
    alert.querySelector(".bhd-save-alert-label").textContent = getSavePromptLabel(prompt, actor);
    alert.hidden = false;
    this.#syncPromptAlerts();
    this.#tickSaveAlert();
    if ( !vibrate ) return;
    try {
      if ( navigator.userActivation?.hasBeenActive ?? true ) navigator.vibrate?.([200, 100, 200]);
    } catch(err) {}
  }

  /* -------------------------------------------- */
  /*  Peticiones de Midi QOL (midi-prompts.js)    */
  /* -------------------------------------------- */

  /**
   * Midi pide una salvación o prueba: sale el aviso grande y se espera a que el jugador toque "Tirar"
   * (o a que se acabe el tiempo límite de Midi, si tiene).
   * @param {object} prompt  Como un SavePrompt, con `midi: true`, `actor` y `timeout` (segundos, 0 = sin límite).
   * @returns {Promise<boolean>}  true si el jugador tocó Tirar; false si se acabó el tiempo.
   */
  promptMidiRoll(prompt) {
    return new Promise(resolve => {
      const finish = tapped => {
        clearTimeout(prompt.timer);
        const index = this.#savePrompts.indexOf(prompt);
        if ( index >= 0 ) {
          this.#savePrompts.splice(index, 1);
          this.#showSaveAlert(false);
        }
        resolve(tapped);
      };
      prompt.resolve = finish;
      if ( prompt.timeout > 0 ) {
        prompt.deadline = Date.now() + (prompt.timeout * 1000);
        prompt.timer = setTimeout(() => finish(false), prompt.timeout * 1000);
      }
      this.#savePrompts.push(prompt);
      this.#showSaveAlert(true);
    });
  }

  /**
   * La tirada que pidió Midi ya se hizo: muestra el total (y éxito / fallo si se ve la CD).
   * @param {object} prompt
   * @param {Roll[]|Roll|object} result  Lo que devuelve Midi.
   */
  onMidiRollDone(prompt, result) {
    const roll = Array.isArray(result) ? result[0] : result;
    if ( !Number.isFinite(roll?.total) ) return;
    const actor = prompt.actor ?? this.actor;
    let label = getSavePromptLabel(prompt, actor);
    if ( prompt.showDC && prompt.dc ) {
      label += ` · ${game.i18n.localize(roll.total >= prompt.dc ? "BHD.Save.Success" : "BHD.Save.Failure")}`;
    }
    useLog(`Tirada de Midi: ${label} = ${roll.total}`);
    this.#showRollResult(label, roll);
  }

  /* -------------------------------------------- */
  /*  Salvaciones por chat de Midi                */
  /*  (midi-chat-saves.js)                        */
  /* -------------------------------------------- */

  /**
   * Midi pidió una salvación por chat (o el DM la reenvía al volver el teléfono): a la cola del aviso.
   * @param {object} prompt  Ver `onRequest` en midi-chat-saves.js (`midiChat: true`, `endsAt`).
   */
  promptMidiChatSave(prompt) {
    if ( this.#midiChatDone.has(prompt.id) ) return;
    const queued = this.#savePrompts.find(p => p.id === prompt.id);
    if ( queued ) {
      queued.endsAt = prompt.endsAt;   // reenviada: solo se corrige el tiempo que queda
      this.#tickSaveAlert();
      return;
    }
    if ( prompt.endsAt && (prompt.endsAt <= Date.now()) ) return;
    this.#savePrompts.push(prompt);
    const first = this.#savePrompts[0] === prompt;
    useLog(first ? "Salvación por chat: aviso en pantalla" : `Salvación por chat: en cola (${this.#savePrompts.length - 1} antes)`);
    this.#showSaveAlert(first);
  }

  /**
   * Cuenta atrás del aviso: barra y segundos de la primera salvación por chat. Las que se quedan sin tiempo salen
   * de la cola (la tira Midi; su resultado llega con `onMidiChatSaveRolled`). Se para cuando no queda ninguna.
   */
  #tickSaveAlert() {
    const now = Date.now();
    for ( const prompt of this.#savePrompts.filter(p => p.midiChat && p.endsAt && (p.endsAt <= now)) ) {
      useLog(`Salvación por chat: se acabó el tiempo; la tira Midi (${prompt.source})`);
      this.#finishMidiChat(prompt, false);
    }
    const prompt = this.#savePrompts[0];
    const running = this.#savePrompts.some(p => p.midiChat && p.endsAt);
    if ( !running ) {
      clearInterval(this.#saveTick);
      this.#saveTick = null;
    }
    else this.#saveTick ??= setInterval(() => this.#tickSaveAlert(), 250);
    if ( !prompt?.midiChat || !prompt.endsAt ) return;
    const alert = this.element?.querySelector(".bhd-save-alert");
    const left = Math.max(0, prompt.endsAt - now);
    const bar = alert?.querySelector(".bhd-save-alert-bar");
    if ( bar ) bar.style.transform = `scaleX(${Math.min(1, left / ((prompt.timeout || 1) * 1000))})`;
    const seconds = alert?.querySelector(".bhd-save-alert-seconds");
    if ( seconds ) seconds.textContent = game.i18n.format("BHD.Save.SecondsLeft", { seconds: Math.ceil(left / 1000) });
  }

  /**
   * Saca del aviso una salvación por chat y pasa a la siguiente de la cola.
   * @param {object} prompt
   * @param {boolean} rolledHere  ¿La tiró el jugador desde el aviso?
   */
  #finishMidiChat(prompt, rolledHere) {
    const index = this.#savePrompts.indexOf(prompt);
    if ( index >= 0 ) this.#savePrompts.splice(index, 1);
    if ( !this.#midiChatDone.has(prompt.id) ) this.#midiChatDone.set(prompt.id, { prompt, rolledHere, total: null });
    if ( index === 0 ) this.#showSaveAlert(this.#savePrompts.length > 0);
  }

  /**
   * Tira la primera salvación por chat del aviso.
   * @param {"advantage"|"normal"|"disadvantage"|null} mode  Null: lo que calculó Midi.
   * @param {Event} [event]
   */
  async #rollMidiChat(mode, event) {
    const prompt = this.#savePrompts[0];
    if ( !prompt?.midiChat ) return;
    this.#finishMidiChat(prompt, true);
    try {
      const roll = await rollMidiChatSave(prompt, mode, event);
      const entry = this.#midiChatDone.get(prompt.id);
      if ( roll && entry && (entry.total === null) ) {
        entry.total = roll.total;
        this.#showRollResult(getSavePromptLabel(prompt, prompt.actor), roll);
      }
    } catch(err) {
      ui.notifications.error(game.i18n.format("BHD.Use.Error", {
        name: getSavePromptLabel(prompt, prompt.actor), error: err?.message ?? String(err)
      }));
    }
  }

  /**
   * Midi ya tiene la tirada (la del jugador, o la suya al acabarse el tiempo): se cierra el aviso si seguía abierto.
   * @param {string} id
   * @param {number|null} total
   */
  onMidiChatSaveRolled(id, total) {
    const queued = this.#savePrompts.find(p => p.id === id);
    if ( queued ) {
      useLog("Salvación por chat: Midi ya la tiene; cierro el aviso");
      this.#finishMidiChat(queued, false);
    }
    const entry = this.#midiChatDone.get(id);
    if ( !entry ) return;
    useLog(`Salvación por chat: Midi recibió la tirada (${total ?? "?"})${entry.rolledHere ? "" : " — la tiró Midi"}`);
    if ( Number.isFinite(total) ) entry.total = total;
    if ( !entry.rolledHere && Number.isFinite(total) ) {
      this.#showRollResult(game.i18n.localize("BHD.Save.MidiRolled"), { total });
    }
  }

  /**
   * Midi decidió si pasó o falló (con todo lo que suma Midi: cobertura, bonificadores, éxito automático...).
   * @param {string} id
   * @param {boolean} success
   */
  onMidiChatSaveResult(id, success) {
    const entry = this.#midiChatDone.get(id);
    if ( !entry ) return;
    const label = `${getSavePromptLabel(entry.prompt, entry.prompt.actor)} · `
      + game.i18n.localize(success ? "BHD.Save.Success" : "BHD.Save.Failure");
    useLog(`Salvación por chat: resultado de Midi — ${label}`);
    this.#showRollResult(label, { total: Number.isFinite(entry.total) ? entry.total : (success ? "✓" : "✗") });
  }

  /**
   * Midi ofrece reacciones: aviso con la lista, una cuenta atrás y "Pasar".
   * @param {object} options
   * @param {Activity[]} options.activities
   * @param {string} options.flavor   Qué la provoca (texto de Midi).
   * @param {string} options.trigger  Quién la provoca.
   * @param {number} options.timeout  Segundos.
   * @returns {Promise<Activity|null>}  La elegida, o null si pasa o se acaba el tiempo.
   */
  promptReaction({ activities, flavor, trigger, timeout }) {
    this.#closeReaction(null);
    const alert = this.element?.querySelector(".bhd-reaction-alert");
    if ( !alert ) return Promise.resolve(null);
    const escape = foundry.utils.escapeHTML;
    const localize = key => escape(game.i18n.localize(key));
    const options = activities.map((activity, index) => {
      const name = (activity.name && (activity.name !== activity.item.name)) ? `${activity.item.name}: ${activity.name}` : activity.item.name;
      return `<button type="button" class="bhd-reaction-option" data-action="bhdReactionUse" data-index="${index}">
        <img src="${escape(activity.item.img)}" alt=""><span>${escape(name)}</span>
      </button>`;
    }).join("");
    alert.innerHTML = `
      <div class="bhd-reaction-box">
        <i class="fa-solid fa-bolt bhd-reaction-icon" aria-hidden="true"></i>
        <strong class="bhd-reaction-title">${localize("BHD.Reaction.Title")}</strong>
        ${trigger ? `<span class="bhd-reaction-trigger">${escape(game.i18n.format("BHD.Reaction.Trigger", { name: trigger }))}</span>` : ""}
        ${flavor ? `<span class="bhd-reaction-flavor">${escape(flavor)}</span>` : ""}
        <div class="bhd-reaction-timer"><span class="bhd-reaction-bar"></span></div>
        <span class="bhd-reaction-seconds"></span>
        <div class="bhd-reaction-options">${options}</div>
        <button type="button" class="bhd-reaction-pass" data-action="bhdReactionPass">${localize("BHD.Reaction.Pass")}</button>
      </div>`;
    alert.hidden = false;
    try {
      if ( navigator.userActivation?.hasBeenActive ?? true ) navigator.vibrate?.([200, 80, 200, 80, 200]);
    } catch(err) {}

    return new Promise(resolve => {
      const ends = Date.now() + (timeout * 1000);
      // En la cola única: con cuenta atrás, así sale antes que lo que puede esperar.
      const entry = enqueuePrompt({ kind: "reaction", label: activities.map(a => a.item.name).join(", "), deadline: ends });
      const bar = alert.querySelector(".bhd-reaction-bar");
      const seconds = alert.querySelector(".bhd-reaction-seconds");
      const update = () => {
        const left = Math.max(0, ends - Date.now());
        if ( bar ) bar.style.transform = `scaleX(${left / (timeout * 1000)})`;
        if ( seconds ) seconds.textContent = game.i18n.format("BHD.Reaction.Seconds", { seconds: Math.ceil(left / 1000) });
      };
      update();
      this.#reaction = {
        activities,
        resolve,
        entry,
        tick: setInterval(update, 250),
        timer: setTimeout(() => {
          useLog("Reacción: se acabó el tiempo");
          this.#closeReaction(null);
        }, timeout * 1000)
      };
      this.#syncPromptAlerts();
    });
  }

  /**
   * Cola única de preguntas: de los avisos de la vista (salvación, reacción) solo se ve el que toca; los demás
   * esperan ocultos (los de Cauldron y las ventanas se ocultan solos, ver decisions.js y mobile-windows.js).
   */
  #syncPromptAlerts() {
    const save = this.element?.querySelector(".bhd-save-alert");
    save?.classList.toggle("bhd-prompt-waiting", !!this.#saveEntry && !isActivePrompt(this.#saveEntry));
    const reaction = this.element?.querySelector(".bhd-reaction-alert");
    reaction?.classList.toggle("bhd-prompt-waiting", !!this.#reaction && !isActivePrompt(this.#reaction.entry));
  }

  /**
   * Cierra el aviso de reacción y devuelve lo elegido.
   * @param {Activity|null} activity
   */
  #closeReaction(activity) {
    const reaction = this.#reaction;
    this.#reaction = null;
    const alert = this.element?.querySelector(".bhd-reaction-alert");
    if ( alert ) alert.hidden = true;
    if ( !reaction ) return;
    clearTimeout(reaction.timer);
    clearInterval(reaction.tick);
    dequeuePrompt(reaction.entry);
    reaction.resolve(activity);
  }

  /**
   * El DM terminó (o no pudo) la reacción elegida.
   * @param {Activity} activity
   * @param {object} result
   */
  onReactionDone(activity, result) {
    if ( result?.uuid ) {
      this.#showRollResult(game.i18n.format("BHD.Reaction.Used", { name: activity.item.name }), { total: "✓" });
      this.#markUsed("reaction");
      return;
    }
    const reason = result?.reason;
    ui.notifications.warn(reason
      ? game.i18n.format(`BHD.Midi.Reason.${reason}`, { name: activity.item.name, error: result?.error ?? "" })
      : game.i18n.format("BHD.Reaction.NotUsed", { name: activity.item.name }));
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
    if ( (activity.actor !== this.actor) || this.#busy.isBusy("use") ) return;
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
    return getTargetArmorClasses().map(({ name, ac }) => {
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
    const label = game.i18n.localize(`BHD.Hud.Basic.${basic.id}.Name`);
    if ( !actor ) return;
    if ( this.#busy.isBusy("use") ) {
      ui.notifications.info(game.i18n.format("BHD.Use.Busy", { name: label }));
      return;
    }
    if ( basic.target ) {
      const ids = await this.#pickTargets({ title: label, max: 1 });
      if ( ids === null ) return;
      setTargets(ids);
    }
    const lock = this.#busy.acquire("use", { label });
    if ( !lock ) return;
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
    } catch(err) {
      useError(`${label} | Error`, err);
      ui.notifications.error(game.i18n.format("BHD.Use.Error", { name: label, error: err?.message ?? String(err) }));
    } finally {
      this.#busy.release(lock);
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
    const firstCheck = !this.#combatChecked;
    this.#combatChecked = true;
    this.#syncCombatTab(!!getActiveCombat(this.actor ?? null));
    this.checkEffectTimers();
    // Turno del personaje o de un compañero con turno propio (si no lo tiene, se usa en el turno del personaje).
    let actor = null;
    let combat = null;
    for ( const candidate of this.myActors ) {
      const candidateCombat = getActiveCombat(candidate);
      if ( !isActorTurn(candidateCombat, candidate) ) continue;
      actor = candidate;
      combat = candidateCombat;
      break;
    }
    if ( !actor ) {
      this.#hideTurnAlert();
      return;
    }
    const key = `${combat.id}-${combat.round}-${combat.turn}`;
    if ( key === this.#alertedTurn ) return;
    this.#alertedTurn = key;
    if ( actor !== getActiveCharacter() ) useLog(`Combate: turno del compañero ${actor.name}`);
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
    const escape = foundry.utils.escapeHTML;
    // Turno de un compañero: el aviso lo dice y el botón cambia la vista a ese compañero.
    const companion = actor !== getActiveCharacter();
    const token = companion ? getCompanionTokens().find(t => t.actor === actor) : null;
    const title = companion ? escape(game.i18n.format("BHD.Companion.TurnAlert", { name: actor.name }))
      : localize("BHD.Combat.YourTurnAlert");
    // La vista muestra a otro (p. ej. el compañero en el turno del personaje): el botón cambia a quien le toca.
    const button = (this.actor !== actor)
      ? `<button type="button" class="bhd-big-btn" data-action="bhdCompanion" data-uuid="${token?.uuid ?? ""}">
          ${escape(game.i18n.format("BHD.Companion.Control", { name: actor.name }))}</button>`
      : `<button type="button" class="bhd-big-btn" data-action="dismissTurnAlert">${localize("BHD.Combat.LetsGo")}</button>`;
    alert.innerHTML = `
      <div class="bhd-turn-alert-box">
        <img class="bhd-turn-alert-img" src="" alt="">
        <span class="bhd-turn-alert-round">${game.i18n.format("BHD.Combat.Round", { round: combat.round })}</span>
        <strong class="bhd-turn-alert-title">${title}</strong>
        <span class="bhd-turn-alert-hint">${localize(atZero ? "BHD.Combat.YourTurnDying" : "BHD.Combat.YourTurnHint")}</span>
        ${button}
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
    const combat = getActiveCombat(actor);
    const combatant = combat?.getCombatantsByActor(actor).find(c => c.isOwner && (c.initiative === null));
    if ( combatant ) {
      await combat.rollInitiative([combatant.id]);
      const initiative = formatInitiative(combat.combatants.get(combatant.id)?.initiative);
      return initiative ? { total: initiative } : null;
    }
    const roll = actor.getInitiativeRoll();
    if ( !roll ) return null;
    await roll.evaluate();
    await roll.toMessage({
      speaker: ChatMessage.implementation.getSpeaker({ actor }),
      flavor: game.i18n.localize("BHD.Sheet.InitiativeRoll")
    });
    // En el teléfono, sin el decimal de desempate.
    return { total: formatInitiative(roll.total) };
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
    if ( tab === "combat" ) this.#combatBadge = false;
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
    // Al soltar un toque largo también llega un clic: ese ya abrió el menú, no se tira.
    if ( this.#consumeLongPressClick(target) ) return;
    await this.#rollCheck(target.dataset, { event, button: target });
  }

  /**
   * Tirada de característica, salvación, habilidad, iniciativa o muerte con dnd5e (sin ventana).
   * El botón queda ocupado como mucho 10 s; si la tirada termina después, el resultado se enseña igual.
   * @param {{type: string, key?: string, label?: string}} data
   * @param {object} [options]
   * @param {"normal"|"advantage"|"disadvantage"} [options.mode="normal"]
   * @param {Event} [options.event]
   * @param {HTMLElement} [options.button]
   */
  async #rollCheck({ type, key, label }, { mode="normal", event, button }={}) {
    const actor = this.actor;
    if ( !actor ) return;
    const lock = this.#busy.acquire("roll", { button, label });
    if ( !lock ) {
      ui.notifications.info(game.i18n.format("BHD.Use.Busy", { name: label ?? "" }));
      return;
    }
    const dialog = { configure: false };
    // Ventaja / desventaja elegidas con el toque largo (dnd5e suma las de sus reglas igual que en la hoja).
    const config = { event };
    if ( mode === "advantage" ) config.advantage = true;
    else if ( mode === "disadvantage" ) config.disadvantage = true;
    try {
      useLog(`Tirada: ${label ?? type}`, { type, key, mode });
      let rolls;
      switch ( type ) {
        case "ability": rolls = await actor.rollAbilityCheck({ ...config, ability: key }, dialog); break;
        case "save": rolls = await actor.rollSavingThrow({ ...config, ability: key }, dialog); break;
        case "skill": rolls = await actor.rollSkill({ ...config, skill: key }, dialog); break;
        case "initiative": rolls = [await this.#rollInitiative(actor)]; break;
        case "death": rolls = await actor.rollDeathSave(config, dialog); break;
      }
      if ( lock.timedOut ) useLog(`Tirada: ${label ?? type} terminó tarde (el botón ya estaba libre)`);
      this.#showRollResult(label, rolls?.[0]);
    } catch(err) {
      useError(`Tirada: ${label ?? type} | Error`, err);
      ui.notifications.error(game.i18n.format("BHD.Use.Error", { name: label ?? "", error: err?.message ?? String(err) }));
    } finally {
      this.#busy.release(lock);
    }
  }

  /**
   * ¿El jugador está contestando algo (ventana de dnd5e o de Midi, objetivos, colocar un área, menú)?
   * Mientras tanto un botón ocupado espera más de 10 s.
   * @returns {boolean}
   */
  #isWaitingForPlayer() {
    if ( this.#picker || this.#place ) return true;
    const chooser = this.element?.querySelector(".bhd-chooser");
    if ( chooser && !chooser.hidden ) return true;
    if ( isDecisionShown() || hasPendingPrompts() ) return true;
    return !!document.querySelector(".bhd-window:not(.bhd-window-blocked), .bhd-relay-dialog");
  }

  /**
   * Un botón ocupado se liberó por tiempo: aviso (en vez de quedarse trabado).
   * @param {object} lock
   */
  #onBusyTimeout(lock) {
    useWarn(`Botón liberado a los ${Math.round((Date.now() - lock.started) / 1000)} s: ${lock.label || lock.name}`);
    const key = lock.midi ? "BHD.Busy.StillWaiting" : "BHD.Busy.Timeout";
    ui.notifications.warn(game.i18n.format(key, { name: lock.label || "" }));
    if ( !lock.midi ) this.#hideToast();
    this.#renderRows();
  }

  /**
   * Al soltar un toque largo el navegador también manda un clic: se ignora (el menú ya está abierto).
   * @param {HTMLElement} target
   * @returns {boolean}  true si este clic hay que ignorarlo.
   */
  #consumeLongPressClick(target) {
    const press = this.#longPress;
    if ( (press?.fired && (press.target === target)) || (Date.now() < this.#suppressClickUntil) ) {
      this.#longPress = null;
      this.#suppressClickUntil = 0;
      return true;
    }
    return false;
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
   * Texto de la regla de Inspiración heroica que trae dnd5e (`CONFIG.DND5E.rules.inspiration`).
   * @returns {Promise<string>}
   */
  async #getInspirationRuleHtml() {
    const uuid = CONFIG.DND5E.rules?.inspiration;
    const page = uuid ? await fromUuid(uuid).catch(() => null) : null;
    const text = page?.text?.content;
    if ( !text ) return `<p>${foundry.utils.escapeHTML(game.i18n.localize("BHD.Inspiration.RuleSummary"))}</p>`;
    return foundry.applications.ux.TextEditor.implementation.enrichHTML(text, { relativeTo: page });
  }

  /**
   * Botón "Regla" de la tarjeta de Inspiración.
   * @this {BHDMobileApp}
   */
  static async #onInspirationRule() {
    await this.#showInfo(game.i18n.localize("BHD.Sheet.Inspiration"), null, await this.#getInspirationRuleHtml());
  }

  /**
   * Usar la Inspiración heroica: volver a tirar el último d20 del personaje (ataque, salvación, prueba) y quedarse
   * con la nueva tirada. Se toma la última tirada d20 suya del chat de los últimos minutos. Se marca como gastada.
   * @this {BHDMobileApp}
   */
  static async #onUseInspiration() {
    const actor = this.actor;
    if ( !actor?.system.attributes?.inspiration ) return;
    const escape = foundry.utils.escapeHTML;
    const rule = `<div class="bhd-item-info">${await this.#getInspirationRuleHtml()}</div>`;

    // La última tirada d20 del personaje (como mucho de hace 10 minutos).
    const since = Date.now() - (10 * 60 * 1000);
    const message = game.messages.contents.findLast(m => (m.timestamp >= since) && (m.speaker?.actor === actor.id)
      && m.isOwner && (m.rolls?.[0] instanceof CONFIG.Dice.D20Roll));
    const roll = message?.rolls[0];
    const flavor = message ? (textOf(message.flavor) || game.i18n.localize("BHD.Inspiration.LastRoll")) : "";
    const content = roll
      ? `<p><strong>${escape(game.i18n.format("BHD.Inspiration.RerollConfirm", { roll: flavor, total: roll.total }))}</strong></p>${rule}`
      : `<p><strong>${escape(game.i18n.localize("BHD.Inspiration.NoRoll"))}</strong></p>${rule}`;
    const choice = await DialogV2.wait({
      window: { title: "BHD.Inspiration.Use" },
      classes: ["bhd-dialog"],
      content,
      buttons: [
        ...(roll ? [{ action: "reroll", label: "BHD.Inspiration.Reroll", icon: "fa-solid fa-dice-d20", default: true }] : []),
        { action: "spend", label: "BHD.Inspiration.SpendOnly", icon: "fa-solid fa-star" },
        { action: "cancel", label: "BHD.Actions.Cancel" }
      ],
      rejectClose: false
    });
    if ( !choice || (choice === "cancel") ) return;
    if ( choice === "reroll" ) {
      const reroll = await roll.reroll();
      await reroll.toMessage({
        speaker: message.speaker,
        flavor: `${flavor} — ${game.i18n.localize("BHD.Inspiration.RerollFlavor")}`
      });
      useLog(`Inspiración: ${actor.name} vuelve a tirar «${flavor}»: ${roll.total} → ${reroll.total}`);
      this.#showRollResult(game.i18n.localize("BHD.Inspiration.RerollFlavor"), reroll);
    }
    else useLog(`Inspiración: ${actor.name} la gasta sin volver a tirar aquí`);
    await actor.update({ "system.attributes.inspiration": false });
  }

  /**
   * El DM (u otro) dio Inspiración a uno de los actores del jugador: aviso con vibración.
   * @param {Actor} actor
   */
  onInspirationGranted(actor) {
    useLog(`Inspiración: ${actor.name} la recibe`);
    this.#showRollResult(game.i18n.format("BHD.Inspiration.Granted", { name: actor.name }), { total: "★" });
    ui.notifications.info(game.i18n.format("BHD.Inspiration.Granted", { name: actor.name }));
    try {
      if ( navigator.userActivation?.hasBeenActive ?? true ) navigator.vibrate?.([150, 80, 150, 80, 300]);
    } catch(err) {}
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
    if ( this.#consumeLongPressClick(target) ) return;
    const { kind, itemId, activityId, hudBlock } = target.dataset;
    const item = this.actor?.items.get(itemId);
    if ( !item ) return;
    const activity = activityId ? item.system.activities?.get(activityId) : null;
    if ( kind === "midi" ) await this.#runMidi(item, activity, { button: target, hudBlock });
    else await this.#runQuick(kind, item, activity ?? null, { event, button: target, hudBlock });
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
    if ( kind === "midi" ) await this.#runMidi(item, activity, { mode, hudBlock });
    else if ( mode === "full" ) await this.#useFull(item, activity, event);
    else await this.#runQuick(kind, item, activity ?? null, { mode, event, hudBlock });
  }

  /**
   * Opción del toque largo en una característica, salvación o habilidad: Ventaja, Normal o Desventaja.
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onCheckMode(event, target) {
    this.#closeChooser();
    const { mode, ...data } = target.dataset;
    await this.#rollCheck(data, { mode, event });
  }

  /**
   * Botón "Reconectar" del panel de ajustes: suelta todo lo que esperaba (botones ocupados, peticiones al DM,
   * menús), reinicia la conexión con el servidor y vuelve a dibujar la vista, sin recargar la página.
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onReconnect(event, target) {
    if ( target.disabled ) return;
    target.disabled = true;
    target.classList.add("bhd-rolling");
    useLog("Reconectar: reinicio de la conexión y de la vista");
    try {
      this.resetPending();
      const ok = await restartConnection();
      const panel = this.element.querySelector(".bhd-settings");
      if ( panel ) panel.hidden = true;
      // Si un dibujo anterior se quedó colgado, no se espera más de 10 s.
      const rendered = await withTimeout(this.render({ force: true }).then(() => true), BUSY_TIMEOUT_MS, false);
      if ( !rendered ) useWarn("Reconectar: la vista tardó demasiado en dibujarse");
      this.onCombatUpdate();
      if ( ok ) Hooks.callAll("bhd-companion.reconnected");
      ui.notifications[ok ? "info" : "warn"](ok ? "BHD.Reconnect.Done" : "BHD.Reconnect.Failed", { localize: true });
    } catch(err) {
      useError("Reconectar | Error", err);
      ui.notifications.error("BHD.Reconnect.Failed", { localize: true });
    } finally {
      target.disabled = false;
      target.classList.remove("bhd-rolling");
    }
  }

  /**
   * Suelta todo lo que estaba esperando: botones ocupados, peticiones al DM sin respuesta, selector de
   * objetivos, colocar un área, menú del toque largo y aviso de "esperando al DM".
   */
  resetPending() {
    cancelPendingCalls("ConnectionLost");
    this.#busy.releaseAll();
    this.#midiPending.clear();
    clearTimeout(this.#longPress?.timer);
    this.#longPress = null;
    this.#suppressClickUntil = 0;
    if ( this.#placeHold ) this.#placeHold.active = false;
    if ( this.#place ) {
      this.#place.api.end(this.#place.sessionId, false);   // quita la vista previa de la TV (si llega)
      this.#finishPlace(null);
    }
    this.#closePicker(null);
    this.#closeChooser();
    this.#hideToast();
    // Preguntas de Cauldron o del DM que quedaron colgadas: se cierran (el DM las enseña en su PC si aún esperan).
    cancelAllDecisions();
  }

  /**
   * Botón "Elegir objeto" de una tarjeta de encantar del panel de resultados.
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onEnchantOpen(event, target) {
    const message = game.messages.get(target.dataset.messageId);
    if ( message ) this.#openEnchantPicker(message);
  }

  /**
   * Encanta el objeto elegido en la lista (como soltarlo en la tarjeta del chat).
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onEnchantPick(event, target) {
    const message = game.messages.get(target.dataset.messageId);
    if ( !message ) return;
    try {
      const effect = await applyEnchantment(message, target.dataset.itemId);
      if ( !effect ) return;
      ui.notifications.info(game.i18n.format("BHD.Enchant.Done", { name: effect.parent?.name ?? "" }));
      const data = prepareEnchantPicker(message);
      if ( data?.max && !data.full ) this.#openEnchantPicker(message);
      else this.#closeChooser();
    } catch(err) {
      useError("Encantar | Error", err);
      ui.notifications.error(game.i18n.format("BHD.Use.Error", { name: message.getAssociatedItem()?.name ?? "", error: err?.message ?? String(err) }));
    }
  }

  /**
   * Quita un encantamiento de la lista y la vuelve a mostrar (para elegir otro objeto).
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onEnchantRemove(event, target) {
    const message = game.messages.get(target.dataset.messageId);
    try {
      await removeEnchantment(message, target.dataset.uuid);
    } catch(err) {
      useError("Quitar encantamiento | Error", err);
    }
    if ( message ) this.#openEnchantPicker(message);
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
    const content = document.createElement("div");
    content.className = "bhd-item-info bhd-item-details";
    content.innerHTML = await renderItemDetails(item);
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
   * @param {HTMLElement} target
   */
  static async #onSaveRoll(event, target) {
    // Al soltar un toque largo también llega un clic: ese ya abrió las opciones, no se tira.
    if ( this.#consumeLongPressClick(target) ) return;
    // Petición por chat de Midi: tira el jugador, con la ventaja / desventaja que calculó Midi.
    if ( this.#savePrompts[0]?.midiChat ) return this.#rollMidiChat(null, event);
    // Petición de Midi: la tirada la hace Midi (midi-prompts.js) en cuanto el jugador toca.
    if ( this.#savePrompts[0]?.midi ) {
      this.#savePrompts[0].resolve(true);
      return;
    }
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
   * Opción del toque largo en el aviso de salvación por chat de Midi: Ventaja, Normal o Desventaja.
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onSaveMode(event, target) {
    return this.#rollMidiChat(target.dataset.mode, event);
  }

  /**
   * Cierra el aviso de salvación sin tirar (se puede tirar desde la tarjeta del chat o la hoja).
   * @this {BHDMobileApp}
   */
  static #onSaveDismiss() {
    if ( this.#savePrompts[0]?.midi ) return;   // Midi espera la tirada
    this.#savePrompts.shift();
    this.#showSaveAlert(false);
  }

  /**
   * Toca una reacción del aviso: la ejecuta el DM.
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onReactionUse(event, target) {
    const activity = this.#reaction?.activities[Number(target.dataset.index)];
    if ( activity ) this.#closeReaction(activity);
  }

  /**
   * No usa ninguna reacción.
   * @this {BHDMobileApp}
   */
  static #onReactionPass() {
    this.#closeReaction(null);
  }

  /**
   * Cierra el resultado de un uso con Midi.
   * @this {BHDMobileApp}
   */
  static #onMidiResultClose() {
    clearTimeout(this.#midiResultTimeout);
    const panel = this.element.querySelector(".bhd-midi-result");
    if ( panel ) panel.hidden = true;
  }

  /**
   * "Colocar área": girar el cono o la línea.
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onPlaceRotate(event, target) {
    await this.#placeStep({ rotate: Number(target.dataset.deg) || 0 });
  }

  /**
   * "Colocar área": confirmar. El DM quita la vista previa y devuelve la posición; luego se pide el uso.
   * @this {BHDMobileApp}
   */
  static async #onPlaceConfirm() {
    const place = this.#place;
    if ( !place || place.busy ) return;
    place.busy = true;
    const result = await place.api.end(place.sessionId, true);
    if ( this.#place !== place ) return;
    place.busy = false;
    if ( !result?.ok ) {
      this.#warnPlaceReason(result?.reason ?? "Expired", place.item, result?.error);
      this.#finishPlace(null);
      return;
    }
    // Criaturas: si quedan más, la siguiente aparece junto a la anterior; si la casilla está ocupada, choca.
    if ( !result.done ) {
      place.state = result;
      this.#renderPlace();
      if ( result.blocked ) this.#placeBump(result.blockReason);
      else {
        const message = this.element.querySelector(".bhd-place-msg");
        if ( message ) message.hidden = true;
        try {
          if ( navigator.userActivation?.hasBeenActive ?? true ) navigator.vibrate?.(30);
        } catch(err) {}
      }
      return;
    }
    useLog(`${place.item.name} (colocar) | Confirmado`, result.value);
    this.#finishPlace(result.value);
  }

  /**
   * "Colocar área": cancelar. No se usa nada (no se gasta el espacio ni el uso).
   * @this {BHDMobileApp}
   */
  static async #onPlaceCancel() {
    const place = this.#place;
    if ( !place ) return;
    useLog(`${place.item.name} (colocar) | Cancelado: no se usa nada`);
    this.#finishPlace(null);
    await place.api.end(place.sessionId, false);
  }

  /**
   * Pestaña Hechizos: activa o quita un filtro (Concentración, Ritual, Preparados).
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onSpellToggle(event, target) {
    const id = target.dataset.filter;
    if ( !["concentration", "ritual", "prepared"].includes(id) ) return;
    let on;
    if ( id === "prepared" ) {
      // "Solo preparados" empieza encendido si hay hechizos sin preparar; el jugador lo apaga para verlos todos.
      on = this.#spellFilters.prepared = !this.#spellFilters.readyOnly;
      this.#spellFilters.readyOnly = on;
      useLog(`Hechizos: ${on ? "solo los preparados" : "todos (también sin preparar)"}`);
    }
    else on = this.#spellFilters[id] = !this.#spellFilters[id];
    target.classList.toggle("bhd-on", on);
    target.setAttribute("aria-pressed", String(on));
    this.#applySpellFilters();
  }

  /**
   * Pestaña Hechizos: filtro por tiempo de lanzamiento (Todo, Acción, Adicional, Reacción).
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onSpellActivation(event, target) {
    const id = target.dataset.filter;
    if ( (id !== "all") && !SPELL_ACTIVATIONS.includes(id) ) return;
    this.#spellFilters.activation = id;
    for ( const chip of this.element.querySelectorAll("[data-action=bhdSpellActivation]") ) {
      const on = chip.dataset.filter === id;
      chip.classList.toggle("bhd-on", on);
      chip.setAttribute("aria-pressed", String(on));
    }
    this.#applySpellFilters();
  }

  /**
   * Toca un círculo de espacio de conjuro: como en la hoja, tocar uno lleno gasta ese y los de después; tocar
   * uno vacío recupera hasta él. Cambia `system.spells.<espacio>.value` (lo mismo que la hoja de dnd5e).
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onSlotPip(event, target) {
    const actor = this.actor;
    const key = target.dataset.slot;
    const n = Number(target.dataset.n);
    const slot = actor?.system.spells?.[key];
    if ( !slot || !Number.isFinite(n) ) return;
    const value = slot.value ?? 0;
    const max = Math.max(slot.max ?? 0, value);
    const next = Math.clamp((n <= value) ? n - 1 : n, 0, max);
    if ( next === value ) return;
    useLog(`Espacios ${key}: ${value} → ${next} (a mano)`);
    await actor.update({ [`system.spells.${key}.value`]: next });
  }

  /**
   * Marca o desmarca un hechizo como preparado (como la hoja de dnd5e), sin pasar del límite que calcula el
   * sistema para su clase.
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onPrepare(event, target) {
    const item = this.actor?.items.get(target.dataset.itemId);
    if ( !item || !canTogglePrepared(item) ) return;
    const preparing = !item.system.prepared;
    if ( preparing ) {
      const limit = getPreparationLimit(item);
      if ( limit && (limit.value >= limit.max) ) {
        ui.notifications.warn(game.i18n.format("BHD.Spells.PrepareFull", limit));
        return;
      }
    }
    useLog(`${item.name}: ${preparing ? "preparado" : "sin preparar"}`);
    await item.update({ "system.prepared": Number(preparing) });
  }

  /**
   * Elige el nivel del hechizo en el menú del toque largo (con Midi).
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onChooseSlot(event, target) {
    this.#quick.slots.set(target.dataset.itemId, target.dataset.slot);
    for ( const chip of this.element.querySelectorAll(".bhd-chooser [data-action=bhdChooseSlot]") ) {
      const on = chip === target;
      chip.classList.toggle("bhd-on", on);
      chip.setAttribute("aria-pressed", String(on));
    }
    this.#renderRows();
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
    const escape = foundry.utils.escapeHTML;
    const actor = (effect.parent instanceof Actor) ? effect.parent : effect.parent?.actor;
    const { duration, source } = describeEffect(effect, actor);
    let html = await foundry.applications.ux.TextEditor.implementation.enrichHTML(
      effect.description || `<p>${escape(game.i18n.localize("BHD.Status.NoDescription"))}</p>`,
      { relativeTo: effect }
    );
    const facts = [
      source ? `<li><strong>${escape(game.i18n.localize("BHD.Effects.From"))}</strong> ${escape(source)}</li>` : "",
      duration ? `<li><strong>${escape(game.i18n.localize("BHD.Effects.Remaining"))}</strong> ${escape(duration)}</li>` : ""
    ].join("");
    if ( facts ) html = `<ul class="bhd-effect-facts">${facts}</ul>${html}`;
    // Lo que modifica el efecto (sus cambios de Foundry / dnd5e).
    const changes = getEffectChanges(effect);
    if ( changes.length ) {
      html += `<h4>${escape(game.i18n.localize("BHD.Effects.Changes"))}</h4><ul class="bhd-effect-changes">${changes.map(c =>
        `<li><code>${escape(c.key)}</code> <span>${escape(c.mode)}</span> <strong>${escape(c.value)}</strong></li>`).join("")}</ul>`;
    }
    useLog(`Efecto: detalle de ${effect.name}`, { duration, source });
    if ( !canRemoveEffect(effect) ) {
      await this.#showInfo(effect.name, effect.img, html);
      return;
    }
    // El jugador es dueño del efecto y lo aplicó él (o algo suyo): puede quitarlo.
    const content = `<div class="bhd-item-info bhd-status-info"><img class="bhd-status-info-img" src="${escape(effect.img ?? "")}" alt="">${html}</div>`;
    const choice = await DialogV2.wait({
      window: { title: effect.name },
      classes: ["bhd-dialog"],
      content,
      buttons: [
        { action: "close", label: "BHD.Actions.Close", icon: "fa-solid fa-check", default: true },
        { action: "remove", label: "BHD.Effects.Remove", icon: "fa-solid fa-trash" }
      ],
      rejectClose: false
    });
    if ( choice !== "remove" ) return;
    useLog(`Efecto: el jugador quita ${effect.name}`);
    await effect.delete();
  }

  /**
   * Avisos de los efectos con duración en combate: su última ronda y cuando se acaban (si Foundry los deja puestos
   * ya vencidos). Se llama con cada cambio del combate.
   */
  checkEffectTimers() {
    for ( const actor of this.myActors ) {
      for ( const effect of actor.temporaryEffects ?? [] ) {
        const { combat, remaining, expired } = getDuration(effect);
        if ( !combat || (remaining === null) ) continue;
        const key = `${effect.uuid}`;
        if ( expired ) {
          if ( this.#effectNotices.get(key) === "ended" ) continue;
          this.#effectNotices.set(key, "ended");
          this.#notifyEffectEnded(effect.name, actor);
        }
        else if ( remaining <= 1 ) {
          if ( this.#effectNotices.has(key) ) continue;
          this.#effectNotices.set(key, "last");
          useLog(`Efecto: última ronda de ${effect.name} (${actor.name})`);
          ui.notifications.warn(game.i18n.format("BHD.Effects.LastRound", { name: effect.name, actor: actor.name }));
        }
        else this.#effectNotices.delete(key);
      }
    }
  }

  /**
   * Hook `deleteActiveEffect`: un efecto temporal de uno de sus actores terminó (o lo quitaron).
   * @param {ActiveEffect} effect
   */
  onEffectDeleted(effect) {
    const actor = (effect.parent instanceof Actor) ? effect.parent : null;
    if ( !actor || !this.myActors.includes(actor) || !effect.isTemporary ) return;
    if ( this.#effectNotices.get(effect.uuid) === "ended" ) return;
    this.#effectNotices.delete(effect.uuid);
    this.#notifyEffectEnded(effect.name, actor);
  }

  /**
   * @param {string} name
   * @param {Actor} actor
   */
  #notifyEffectEnded(name, actor) {
    useLog(`Efecto: terminó ${name} (${actor.name})`);
    ui.notifications.info(game.i18n.format("BHD.Effects.EndedNotice", { name, actor: actor.name }));
  }

  /**
   * Enseña lo que enlaza una descripción: un objeto o hechizo (su detalle de dnd5e) o una página de diario
   * (su texto), con los enlaces de dentro también utilizables.
   * @param {string} uuid
   */
  async #openLinkedDocument(uuid) {
    let doc;
    try {
      doc = await fromUuid(uuid);
    } catch(err) {
      console.warn("BHD Companion | No se pudo abrir el enlace", uuid, err);
    }
    if ( !doc ) return;
    if ( doc instanceof JournalEntry ) doc = doc.pages.contents.sort((a, b) => a.sort - b.sort)[0] ?? doc;
    useLog(`Enlace abierto: ${doc.name}`, uuid);
    if ( doc instanceof Item ) {
      const html = `<div class="bhd-item-details">${await renderItemDetails(doc)}</div>`;
      await this.#showInfo(doc.name, null, html);
      return;
    }
    const text = doc.text?.content ?? doc.system?.description?.value ?? doc.description ?? "";
    const html = await foundry.applications.ux.TextEditor.implementation.enrichHTML(
      text || `<p>${foundry.utils.escapeHTML(game.i18n.localize("BHD.Status.NoDescription"))}</p>`, { relativeTo: doc }
    );
    await this.#showInfo(doc.name, null, html);
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
    const combat = getActiveCombat(this.actor ?? null);
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
   * Filtro del diario: Todo, Tiradas o Combate.
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onDiaryFilter(event, target) {
    this.#diaryFilter = target.dataset.filter;
    this.render({ parts: ["main"] });
  }

  /**
   * Limpia el diario del actor que se ve (la sesión empieza de nuevo).
   * @this {BHDMobileApp}
   */
  static async #onDiaryClear() {
    const actor = this.actor;
    if ( !actor ) return;
    const ok = await DialogV2.confirm({
      window: { title: "BHD.Diary.Clear" },
      classes: ["bhd-dialog"],
      content: `<p>${foundry.utils.escapeHTML(game.i18n.format("BHD.Diary.ClearConfirm", { name: actor.name }))}</p>`,
      rejectClose: false
    });
    if ( !ok ) return;
    clearDiary(actor);
    useLog(`Diario: limpiado para ${actor.name}`);
    this.render({ parts: ["main"] });
  }

  /**
   * Algo nuevo en el diario: se redibuja si se está viendo (sin molestar si el jugador escribe en sus notas).
   */
  onDiaryChanged() {
    if ( this.activeTab !== "notes" ) return;
    if ( document.activeElement?.matches?.("[data-bhd-notes]") ) return;
    this.render({ parts: ["main"] });
  }

  /**
   * Toca un contador de recursos: abre su detalle (o lo cierra si ya estaba abierto).
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onResource(event, target) {
    const id = target.dataset.id;
    this.#openResource = (this.#openResource === id) ? null : id;
    useLog(this.#openResource ? `Recursos: detalle de ${id}` : "Recursos: detalle cerrado");
    this.render({ parts: ["main"] });
  }

  /**
   * Botones − / + del detalle de un recurso: gasta o recupera un uso a mano.
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onResourceStep(event, target) {
    const actor = this.actor;
    if ( !actor ) return;
    const step = Number(target.dataset.step);
    useLog(`Recursos: ${step > 0 ? "recupera" : "gasta"} un uso de ${target.dataset.id} a mano`);
    try {
      await adjustResource(actor, target.dataset.id, step);
    } catch(err) {
      useError("Recursos | Error", err?.message ?? String(err));
      ui.notifications.error(err?.message ?? String(err));
    }
  }

  /**
   * Cabecera: abre la bandeja de dados.
   * @this {BHDMobileApp}
   */
  static #onDiceTray() {
    this.#diceTray?.open();
  }

  /**
   * Total de una tirada de la bandeja de dados en el aviso de la vista.
   * @param {string} formula
   * @param {Roll} roll
   */
  showDiceResult(formula, roll) {
    this.#showRollResult(formula, roll);
  }

  /**
   * Cabecera: vuelve de la forma transformada (Wild Shape...) a la original (lo hace el DM si está conectado).
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onRevertForm(event, target) {
    const form = getTransformedForm(getActiveCharacter());
    if ( !form ) return;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "BHD.Transform.RevertTitle" },
      classes: ["bhd-dialog"],
      content: `<p>${foundry.utils.escapeHTML(game.i18n.format("BHD.Transform.RevertConfirm", { name: form.name }))}</p>`,
      rejectClose: false
    });
    if ( !confirmed ) return;
    target.disabled = true;
    useLog(`Volver a la forma original: ${form.name}`);
    const result = await requestRevertForm(form);
    if ( !result?.ok ) {
      useWarn("Volver a la forma original: no se pudo", result);
      target.disabled = false;
      ui.notifications.warn(game.i18n.format("BHD.Transform.RevertFailed", { error: result?.error ?? result?.reason ?? "" }));
      return;
    }
    ui.notifications.info(game.i18n.localize("BHD.Transform.Reverted"));
    this.render();
  }

  /**
   * Selector de la cabecera (o botón del aviso de turno): muestra el personaje o un compañero.
   * @this {BHDMobileApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target  Con data-uuid (vacío: el personaje).
   */
  static #onCompanion(event, target) {
    this.#hideTurnAlert();
    const uuid = target.dataset.uuid || null;
    if ( (uuid ?? null) === this.#companionUuid ) return;
    this.#selectCompanion(uuid);
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

/* -------------------------------------------- */
/*  Datos de las tarjetas de dnd5e 5 y 6        */
/* -------------------------------------------- */

/**
 * ¿Las tarjetas del chat guardan sus datos en `message.system` (dnd5e 6) en lugar de flags (dnd5e 5)?
 * @returns {boolean}
 */
function usesMessageSystemData() {
  return !foundry.utils.isNewerVersion("6.0.0", game.system.version);
}

/**
 * Datos del mensaje de una tirada para que cuelgue de su tarjeta (`system.origin` en dnd5e 6).
 * @param {string} messageId
 * @returns {object}
 */
function getOriginMessageData(messageId) {
  return usesMessageSystemData() ? { "system.origin": messageId } : { "flags.dnd5e.originatingMessage": messageId };
}

/**
 * Id de la tarjeta de la que sale este mensaje (p. ej. la tirada de daño de un ataque).
 * @param {ChatMessage} message
 * @returns {string|undefined}
 */
function getOriginMessageId(message) {
  // En los datos guardados es el id (ya preparado sería el documento).
  const origin = message._source.system?.origin;
  return (typeof origin === "string") ? origin : message.getFlag("dnd5e", "originatingMessage");
}

/**
 * Id del objeto que usó la tarjeta (`system.item.id` en dnd5e 6).
 * @param {ChatMessage} message
 * @returns {string|undefined}
 */
function getMessageItemId(message) {
  return message._source.system?.item?.id ?? message.getFlag("dnd5e", "item.id");
}

/**
 * Nombre y CA de los objetivos marcados, igual que los guarda dnd5e en la tarjeta de ataque (con cobertura
 * total la CA es null). Se calcula aquí porque dnd5e 6 retiró `dnd5e.utils.getTargetDescriptors`.
 * @returns {{name: string, ac: number|null}[]}
 */
function getTargetArmorClasses() {
  const targets = [];
  for ( const target of game.user.targets ) {
    const token = target.document ?? target;
    const actor = token.actor;
    if ( !actor ) continue;
    const ac = actor.statuses.has("coverTotal") ? null : actor.system.attributes?.ac?.value;
    targets.push({ name: token.name, ac: ac ?? null });
  }
  return targets;
}

/**
 * Texto plano de un trozo de HTML (sabor de una tirada, descripción corta).
 * @param {string} html
 * @returns {string}
 */
function textOf(html) {
  const template = document.createElement("template");
  template.innerHTML = String(html ?? "");
  return template.content.textContent.replace(/\s+/g, " ").trim();
}
