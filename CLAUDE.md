# BHD Companion — guía del proyecto

Módulo de Foundry VTT **v13** (id `bhd-companion`) para el sistema **dnd5e** (5.x).
Se usa en la tienda **Battlehammer's Dungeon (BHD)**: una TV en la mesa muestra el mapa de
Foundry y 5 jugadores participan solo con su teléfono. Cuando un jugador entra desde un
teléfono, el módulo reemplaza la interfaz normal de Foundry por una vista móvil propia
(hoja de personaje, tiradas, combate en tiempo real), estilo D&D Beyond.

## Sobre el usuario

- No sabe programar. Claude escribe todo el código.
- Después de cada cambio: explicar **en español sencillo** qué se hizo y **cómo probarlo**
  paso a paso en Foundry (qué abrir, qué hacer clic, qué debería verse).
- Trabaja en Windows. Prueba primero en Foundry local; la partida real está en **The Forge**,
  donde los módulos se instalan con un enlace de manifest.

## Reglas técnicas

- Solo APIs de Foundry v13: `foundry.applications.api.ApplicationV2` +
  `HandlebarsApplicationMixin`, `Hooks`, documentos (`Actor`, `Item`, `Combat`, `ChatMessage`),
  `game.settings` y `game.socket` (canal `module.bhd-companion`, ya habilitado con `"socket": true`).
- Tiradas siempre con las APIs del sistema dnd5e (p. ej. `actor.rollSkill`,
  `actor.rollAbilityCheck`, `actor.rollSavingThrow`, `item.use()` / activities),
  nunca recalculando fórmulas a mano.
- Sin servidor externo, sin dependencias de pago, sin frameworks pesados, sin paso de build:
  JavaScript moderno (ES modules), Handlebars y CSS puro. No usar jQuery (v13 trabaja con
  `HTMLElement`).
- Todo el CSS va bajo clases con prefijo `.bhd-` para no romper la interfaz normal.
- La vista móvil solo se activa para jugadores en teléfono. El cliente del GM y el de la TV
  deben seguir viéndose como Foundry normal.
- Textos de interfaz en `lang/es.json` (y `lang/en.json`) bajo la clave `BHD.*`, usando
  `game.i18n.localize`.
- Plantillas en `templates/`, estilos en `styles/`, código en `scripts/`.
- Subir `version` en `module.json` en cada entrega que se publique.
- Commit de git al terminar cada etapa (o subetapa que funcione).

- En Windows PowerShell 5.1 no reescribir archivos con `Get-Content`/`Set-Content`: rompe los
  acentos (UTF-8). Usar las herramientas Write/Edit.
- Sin Node en el PATH. Para comprobar sintaxis: copiar el `.js` como `.mjs` a la carpeta
  scratchpad y ejecutar `Foundry Virtual Tabletop.exe --check archivo.mjs` con
  `ELECTRON_RUN_AS_NODE=1`.
- El código fuente de Foundry v13 instalado (`C:\Program Files\Foundry Virtual Tabletop\resources\app\client`)
  es la referencia para verificar APIs antes de usarlas.

## Estructura

```
module.json                  manifiesto del módulo
scripts/main.js              punto de entrada: hooks init / setup / ready
scripts/constants.js         MODULE_ID y rutas
scripts/settings.js          configuraciones del módulo
scripts/device.js            decide si este cliente usa la vista móvil
scripts/mobile-mode.js       prepara el cliente para la vista móvil (sin mapa, avisos)
scripts/apps/mobile-app.js   BHDMobileApp (ApplicationV2) — la vista móvil, acciones (tiradas, vida)
scripts/apps/character-data.js  elegir personaje y preparar sus datos para las plantillas
scripts/apps/actions-data.js    datos de la pestaña Acciones (ataques, hechizos, rasgos, consumibles)
scripts/apps/combat-data.js     datos de la pestaña Combate (turnos, vida aproximada, salvaciones de muerte)
scripts/apps/inventory-data.js  datos de la pestaña Inventario (objetos, contenedores, monedas, peso)
scripts/apps/notes-data.js      datos de la pestaña Notas (notas personales, personalidad, biografía)
scripts/apps/move-data.js       datos de la pestaña Mover (ficha, pies usados / restantes, cruceta)
scripts/apps/combat-hud-data.js datos del HUD de combate (bloques, opciones por bloque, tarjetas de objetivos)
scripts/movement.js          mover fichas desde el teléfono: reglas, canal del módulo, lado del DM, seguir en la TV
scripts/economy.js           acción / adicional / reacción / Correr usados en el turno (flag del combatiente)
scripts/targets.js           objetivos: fichas reales del mapa oculto; sin mapa, PhoneTarget; aviso a la TV
scripts/mobile-templates.js  áreas de hechizo (plantillas) sin mapa en vista móvil
scripts/mobile-dialogs.js    ventanas de dnd5e compactas (secciones plegadas) en vista móvil
scripts/mobile-windows.js    qué ventanas se permiten en vista móvil (cierra las de otros módulos), una a la vez
scripts/remote-use.js        modo ligero: el PC del DM usa la actividad por el jugador (socketlib)
scripts/use-log.js           registro paso a paso de los usos del teléfono (consola del teléfono y del DM)
scripts/connection.js        reconexión sin límite y aviso "Sin conexión" en vista móvil
scripts/wake-lock.js         pantalla siempre encendida (Screen Wake Lock API)
scripts/home-screen.js       manifiesto de app web y etiquetas apple-* (añadir a pantalla de inicio)
icons/icon-{180,192,512}.png icono de la app (generado con System.Drawing de PowerShell)
templates/mobile/*.hbs       partes de la vista: header, main, turn, nav; parciales de pestaña:
                             character.hbs, actions.hbs, action-row.hbs, combat.hbs, death-saves.hbs,
                             inventory.hbs, inventory-row.hbs, inventory-container.hbs, notes.hbs, move.hbs;
                             settings.hbs y target-picker.hbs (se dibujan con renderTemplate)
styles/bhd-companion.css     estilos
lang/es.json, en.json        traducciones
```

## Cómo funciona la vista móvil (decisiones de la etapa 1)

- **Cuándo:** se decide una sola vez en el hook `setup` (documentos listos, mapa e interfaz
  aún sin crear). Condiciones: ajuste `enabled` activo, usuario no GM, ajuste de cliente
  `preferNormal` desactivado, y (`forceAll` o pantalla pequeña: lado corto de la pantalla o
  ancho de ventana < 768 px).
  **Desde 0.8.4** (`device.js`): modo = `?bhd=mobile|normal|auto` del enlace (recordado en `sessionStorage`
  de la pestaña) o el ajuste de cliente `viewMode` ("Vista de BHD Companion": auto / mobile / normal).
  Automático (`isMobileDevice`): nunca un televisor (user agent de TV), "Macintosh" con
  `maxTouchPoints > 1` = iPad (Safari de iPad dice ser Mac), y si no, hace falta pantalla táctil: user agent
  móvil sin ratón (`any-pointer: fine`), o puntero principal táctil (`pointer: coarse` + `hover: none`) con
  lado corto ≤ 1100 px, o pantalla pequeña sin ratón. Un PC con la ventana estrecha ya **no** entra.
  El GM nunca. `?bhd=mobile` manda sobre `preferNormal`; "Volver a la interfaz normal" y el botón
  "Vista móvil" recargan sin el `?bhd=` (`reloadWithoutUrlMode`). La decisión y los datos del
  dispositivo salen en consola.
- **Mapa oculto (desde 0.9.0):** el teléfono **sí carga el mapa** (Midi QOL necesita fichas `Token`: sin ellas
  fallaba con "You must provide an embedded Document instance as the input for a PlaceableObject"), oculto y
  barato (`prepareHiddenCanvas`): hook `canvasConfig` (resolución 0.5, `low-power`), `_configurePerformanceMode`
  envuelto (modo LOW, sin msaa/smaa/mipmaps, `lightSoftEdges: false`, 10 FPS), `EffectsCanvasGroup#activateAnimation`
  sin animar luces, `canvas.stage.renderable = false` (no se pinta nada, también FXMaster / Sequencer) y
  `SoundsLayer#_syncPositions` sin oyentes salvo `phoneMusic`. Dice So Nice (`diceSoNiceMessagePreProcess`,
  `messageHookDisabled`, `showForRoll`, `#dice-box-canvas` oculto) y `Sequencer.EffectManager._playEffect`
  se anulan en el teléfono. Nunca con `game.settings.set` ni sustituyendo `get` (The Forge sincroniza).
  `followToken` no se ejecuta en vista móvil. Objetivos: `canvas.tokens.setTargets` con las fichas reales.
- **Modo ligero** (ajuste del teléfono `lightMode`, recarga): sin mapa, como antes de 0.9.0 (lo de abajo). Con
  Midi QOL y sin mapa (o el mapa en otra escena que la activa), `shouldUseRemotely` → `#useRemotely`: el
  teléfono elige actividad y pide por socketlib (`executeAsGM("useActivity")`) al DM, que comprueba dueño,
  pone los objetivos del jugador como suyos (debe ver la escena activa), hace `activity.use` con
  `configure: false` y `workflowOptions` (sin confirmar objetivos, ataque / daño automáticos, ventaja) y
  restaura sus objetivos; en cola. El teléfono llama a `onPostUseActivity` con la tarjeta devuelta.
  Limitación: sin ventana de espacio de conjuro (el que dnd5e propone), sin aviso de total en el teléfono.
- **Sin mapa (solo modo ligero):** en `mobile-mode.js` `Canvas.prototype.initialize` se vuelve vacío (lo mismo que hace
  Foundry con `core.noCanvas`): no se crea WebGL, `canvas.initialized/ready` quedan en false. **No se toca
  ni se finge `core.noCanvas`** (0.8.2): antes se sustituía `game.settings.get` y The Forge, que sincroniza
  los ajustes de cliente, guardó `true` y mostraba "Difference in client settings detected". Lo que Foundry
  evita con ese ajuste también se evita a mano: `CONFIG.ui.placeables` con `_canRender() → false` y
  `VideoHelper#createThumbnail` con el icono de vídeo. `game.scenes.current` ahora es la escena activa.
- **Avisos silenciados:** `CONFIG.ui.notifications` se reemplaza por una subclase que descarta
  `ERROR.RESOLUTION.*` (Foundry exige pantalla de PC) e `INFO.SceneViewCanvasDisabled`.
- **Interfaz oculta:** clase `bhd-mobile` en `<body>`; el CSS oculta `#interface`, `#board`,
  `#hud`, `#camera-views`, `#pause`. Las ventanas de Foundry (diálogos) siguen apareciendo
  encima de la vista (z-index 10 < ventanas).
- **App:** `BHDMobileApp` con `window.frame/positioned = false`, pestañas en `TABS.primary`.
  Las pestañas usan la acción propia `bhdTab` (el `_onClickTab` de Foundry usa
  `event.target` y falla al tocar el icono). `close()` ignora cierres salvo `{bhdForce: true}`.
- **Salida / regreso:** "Volver a la interfaz normal" (en el panel de ajustes del engranaje, desde
  0.7.0) pone `preferNormal = true` y recarga. En la
  interfaz normal, si el dispositivo podría usar la vista móvil, aparece un botón flotante
  "Vista móvil" que lo revierte.
- Los CSS del núcleo de Foundry están en `@layer`, así que los estilos del módulo ganan.
- **Ojo con el CSS del núcleo:** todo `<button>` trae `height: 2em; min-height: 2em`. Cualquier
  botón con varias líneas (tarjetas) necesita `height: auto` (la hoja lo pone en `.bhd-sheet :where(button)`).
  Las cuadrículas usan `minmax(0, 1fr)`, no `1fr`, para que un texto largo no ensanche la vista.

## Hoja de personaje (decisiones de la etapa 2)

- **Qué personaje:** `game.user.character`; si no hay, el primero de tipo `character` del que el
  usuario es dueño. Con más de uno aparece un selector que hace `game.user.update({character})`
  (los jugadores pueden cambiar su propio `character`).
- **Datos:** solo valores ya calculados por dnd5e (`system.attributes.*`, `abilities[k].mod`,
  `abilities[k].save.value`, `skills[k].total`); formato con `dnd5e.utils.formatNumber/formatLength`.
- **Tiradas:** `rollAbilityCheck` / `rollSavingThrow` / `rollSkill` con `{ configure: false }`
  (un toque = tirada normal, sin ventana; ventaja/desventaja queda para la etapa 3).
  Iniciativa: si el personaje está en el combate sin iniciativa → `combat.rollInitiative([id])`;
  si no → `actor.getInitiativeRoll()` + `toMessage` (evita `rollInitiativeDialog`, que sin
  mapa crearía combatientes sin ficha). El resultado se muestra unos segundos en el teléfono
  (`.bhd-toast`); el mensaje completo va al chat.
- **Vida:** `actor.applyDamage(n)` / `applyDamage(-n)` / `applyTempHP(n)` (la temporal no se acumula).
- **Tiempo real:** hooks de `updateActor`, `create/deleteActor`, `*Item`, `*ActiveEffect`, `updateUser`
  con un `render()` agrupado (debounce 50 ms). `ui.notifications` sí se ve en móvil (va en `<body>`).

## Pestaña Acciones (decisiones de la etapa 3)

- **Datos** (`scripts/apps/actions-data.js`): armas con `system.equipped`; hechizos agrupados con la
  misma lógica que `_prepareSpellbook` de la hoja de dnd5e (`CONFIG.DND5E.spellcasting[*]`,
  `getSpellSlotKey`, `getAvailableLevels`); métodos `isSingleLevel` (pacto) → todos los hechizos
  de nivel 1+ en una sección, con etiqueta "Nv. X". Qué se muestra (`isSpellShown`, 0.4.2): trucos,
  `prepared` 1/2, métodos que no preparan (innato, a voluntad, ritual) y **todos los de pacto**
  (dnd5e 5.x los deja con `prepared: 0`; ocultarlos dejaba vacía la sección del brujo). Solo se
  ocultan los sin preparar de una clase con `spellcasting.preparation.max > 0` (vía
  `system.classIdentifier`; si no se sabe la clase, si alguna clase con ese método prepara).
  Rasgos (`feat`) con actividades; consumibles con cantidad > 0, sin munición.
  Resumen con `item.labels` (activation, range, damages, toHit), CD de la actividad `save`,
  usos de `system.uses` o de la primera actividad con usos.
- **Filtros y buscador:** se aplican en `#applyActionFilters` ocultando filas con `hidden`
  (sin volver a dibujar). Cada fila lleva `data-activation` (tipos de activación del objeto y sus
  actividades) y `data-search` (nombre sin acentos). El buscador solo afecta a hechizos.
- **Usar:** `item.use({ event })`, flujo normal de dnd5e (elegir actividad, ventana de espacio de
  conjuro, gasto, ataque automático con su ventana de ventaja/desventaja). La tarjeta del chat se
  muestra en un panel inferior (`.bhd-tray`, fuera de las partes de la plantilla) con
  `message.renderHTML()`, que trae los botones de dnd5e ya conectados (daño, curación...). Los
  mensajes con `flags.dnd5e.originatingMessage` de esa tarjeta se añaden al panel (hooks
  `create/update/deleteChatMessage`). El total de ataque/daño sale en el aviso
  (hooks `dnd5e.rollAttackV2` / `dnd5e.rollDamageV2`).
- **Áreas sin mapa** (`scripts/mobile-templates.js`): en vista móvil se sustituye
  `dnd5e.canvas.AbilityTemplate.fromActivity`; captura los datos con el hook
  `dnd5e.preCreateActivityTemplate` (devolviendo `false`) y crea el `MeasuredTemplate` en
  `game.scenes.active`, centrado en la ficha del personaje. El DM la mueve en la TV.
  Requiere el permiso `TEMPLATE_CREATE` (los jugadores lo tienen por defecto).
- **Ventanas en el teléfono** (`scripts/mobile-windows.js`, 0.8.2): hooks `render/closeApplicationV2` y
  `render/closeApplication` (V1). Solo se quedan las ventanas con marco que sean `Dialog5e` de dnd5e,
  `ActivityChoiceDialog`, las propias (clase `bhd-dialog` en nuestros `DialogV2`) y otros `DialogV2` /
  `Dialog` V1 abiertos ≤ 3 s después de un toque; el resto (registro de combate en ventana, popups de
  módulos, avisos de The Forge) se cierra al aparecer (`closeStrayWindows` en `ready` para las de la carga).
  Pila de permitidas: solo la última se ve (`.bhd-window-waiting` oculta las demás). CSS
  `:is(.application:has(> .window-header), .window-app)`: invisibles sin `.bhd-window`, centradas
  (ancho de pantalla − 16 px; en ≥ 700 px, 560 px) con `!important` sobre la posición en línea;
  sube las variables `--font-size-*`. Diálogos propios nuevos: poner `classes: ["bhd-dialog"]`.
  Desde 0.8.3 también se permiten las ventanas de Midi QOL (clases `Midi*` / `TargetConfirmation*` o
  clase CSS `midi*`) y **cualquier** ventana mientras dura un uso del teléfono (`beginUse` / `endUse`);
  las que no son de dnd5e llevan `.bhd-foreign-window`. Cada ventana cerrada o mostrada sale en consola.
- **Ventanas compactas** (`scripts/mobile-dialogs.js`, 0.4.1): hook `renderDialog5e` añade
  `.bhd-compact` y pliega partes poco importantes (`FOLDED_PARTS`: en `activity-usage`
  concentración / recursos / área; en `roll-configuration` fórmula y opciones) con un botón
  `.bhd-fold-toggle`. No pliega si hay avisos o un selector de tipo de daño. Lo abierto se recuerda
  por ventana (WeakMap) porque dnd5e redibuja partes al cambiar opciones.
- **Toque rápido / toque largo** (0.4.1): tocar = `#useItem(item, "normal")`; mantener 450 ms
  (escuchado en `this.element`, se cancela si el dedo se mueve > 10 px) abre `.bhd-chooser`
  con Ventaja / Normal / Desventaja (si tiene actividad de ataque) o Usar, y "Más opciones".
  Hooks en `main.js`: `dnd5e.preUseActivity` → `configure = false` si la actividad es de
  `SIMPLE_ACTIVITY_TYPES`, `scaling === false` (sin elegir espacio) y no hay que terminar otra
  concentración; `dnd5e.preRollAttackV2` / `preRollDamageV2` → `dialog.configure = false` y
  `config.advantage/disadvantage` según `#pendingAttack` (válido 3 s tras el uso). "Más opciones"
  (`#fullOptionsItem`) deja todas las ventanas de dnd5e para ese objeto. Los hechizos de nivel
  muestran la ventana de uso (compacta) para elegir el espacio, salvo que `hasSingleSlotChoice`
  (0.4.2, mismas reglas que `_prepareScalingContext` de dnd5e: `slot.max`, `slot.type`, nivel
  mínimo, `exclusive.spells/slots`) vea un solo tipo de espacio con usos y sea el que dnd5e ya
  eligió (p. ej. brujo solo con pacto): entonces se lanza directo y dnd5e gasta ese espacio y
  escala al nivel del espacio.
- **Midi QOL y registro de usos** (0.8.3): `#useItem` pasa `midiOptions.workflowOptions.targetConfirmation =
  "none"` si Midi está activo (su `resolveTargetConfirmation` usa `ui.controls` y fichas del mapa y fallaba
  sin avisar; los objetivos ya se eligen en el teléfono). Midi sustituye `activity.use` (clona el objeto, crea
  su Workflow, lee `game.user.targets`). Cada paso (toque, use(), preUseActivity, postUseActivity, tiradas,
  hooks `midi-qol.*`) se anota con `useLog` en la consola del teléfono y en la del DM (canal del módulo,
  tipo `useLog`). Errores → `ui.notifications.error`; uso sin tarjeta → aviso; si el uso no termina en
  20 s (`USE_TIMEOUT`) se libera `#using` para no dejar el teléfono bloqueado. La tarjeta se abre en el
  panel ya en `postUseActivity` (Midi tarda en devolver). Midi en un cliente sin mapa: los objetivos son
  `PhoneTarget` (no `Token`), así que `getToken`/`getTokenDocument` de Midi no los reconocen; **sin probar**.
- Los clics dentro del panel con `data-action` desconocido llegan también a `BHDMobileApp`, que
  los ignora; no usar en la app nombres de acción que use dnd5e en sus tarjetas.

## Pestaña Combate (decisiones de la etapa 4)

- **Qué combate** (`getActiveCombat` en `scripts/apps/combat-data.js`): el `active` de la escena
  activa (la de la TV) o cualquier `active`. No se usa `game.combat` (depende del registro de
  combate y de la escena vista, que sin mapa no son fiables). "Mi combatiente": `combatant.actor
  === actor` o `combatant.actorId === actor.id` (fichas no vinculadas).
- **Lista:** `combat.turns` filtrado como el registro de Foundry (`combatant.visible`) y sin fichas
  ocultas ajenas. "Sigue" salta a los no visibles y, con `skipDefeated`, a los derrotados.
  Retrato: `combatant.img`.
- **Vida aproximada:** para todos menos el propio personaje; Sano (completa), Herido (> 50 %),
  Ensangrentado (≤ 50 %), Casi muerto (≤ 25 %), Derrotado (0 PG o `isDefeated`). Para los
  combatientes sin jugador dueño se oculta con el ajuste de mundo `showEnemyHealth` (sin recargar:
  `onChange` redibuja la app). Los datos de los actores llegan a todos los clientes, por eso se puede.
- **Turno:** `app.onCombatUpdate()` (hooks `create/update/deleteCombat`, `*Combatant`, cambio de
  personaje y primer dibujo) muestra `.bhd-turn-alert` (fuera de las partes, z-index 5) y
  `navigator.vibrate` (no existe en iPhone). Se avisa una vez por `combate-ronda-turno`.
  La parte `turn` (`turn.hbs`, entre main y nav) es la barra "Es tu turno · Terminar turno" en
  todas las pestañas; la variable CSS `--bhd-turn-bar` sube el panel y el aviso de tirada.
  Terminar turno = `combat.nextTurn()` (Foundry deja a los jugadores cambiar el turno).
- **Salvaciones de muerte** (`death-saves.hbs`, en Personaje y Combate, solo con 0 PG):
  `actor.rollDeathSave({ event }, { configure: false })`; dnd5e aplica éxitos/fallos, el 20 natural
  y el mensaje. Tras 3 éxitos dnd5e pone los contadores a 0 (no hay "estable" automático).
- La iniciativa del botón usa el mismo `#rollInitiative` de la hoja (con `getActiveCombat`).
- Actores del combate (vida, efectos) también disparan el redibujado.

## Inventario, notas y descansos (decisiones de la etapa 5)

- **Inventario** (`scripts/apps/inventory-data.js`): secciones de `CONFIG.Item.dataModels[*].inventorySection`
  (orden de dnd5e) con los objetos fuera de contenedores; los `container` van aparte como `<details>`
  recursivos (`inventory-container.hbs`, hasta 5 niveles), abiertos recordados en `#openContainers`.
  Peso de fila `system.totalWeight` + `dnd5e.utils.formatWeight`; carga de
  `system.attributes.encumbrance` (marcas y avisos solo con la regla `variant`); sintonización de
  `system.attributes.attunement` (no deja pasar del máximo).
- Acciones con prefijo `bhd*` (`bhdEquip`, `bhdAttune`, `bhdQuantity`, `bhdRest`) para no chocar con
  las de las tarjetas de dnd5e en el panel. Cantidad: − / + cambia el número al momento y se guarda
  400 ms después del último toque (`#pendingQuantities`). Monedas: `change` del input → `system.currency.*`.
- `itemInfo` muestra `system.unidentified.description` a jugadores si el objeto no está identificado.
- **Notas** (`scripts/apps/notes-data.js`): flag `flags.bhd-companion.notes` del actor; se guardan 1 s
  después de escribir o al salir del cuadro. `#notesDraft` conserva lo no guardado al redibujar y
  `_preSyncPartState/_syncPartState` recuperan cursor y foco. `main.js` no redibuja en `updateActor`
  propios que solo tocan flags del módulo. Personalidad y biografía (`enrichHTML`) solo lectura.
- **Descansos:** `actor.shortRest()` / `longRest()`; la ventana de dnd5e es la confirmación (y en el
  corto permite gastar dados de golpe). Si `dnd5e.allowRests` está desactivado, solo un aviso.
  Al terminar, aviso con los PG recuperados (`result.deltas.hitPoints`).

## Uso real en la tienda (decisiones de la etapa 6)

- **Solo la pestaña visible:** `_prepareContext` prepara hoja / acciones / inventario / notas solo si
  es la pestaña activa (`this.tabGroups.primary`), y `main.hbs` solo dibuja la sección con
  `tab.active`. `#onTab` cambia `tabGroups` y hace `render({ parts: ["main", "nav"] })` (ya no usa
  `changeTab`), y sube al principio; tocar la pestaña actual también sube. Combate y salvaciones
  de muerte se preparan siempre (barra de pestañas y barra de turno).
- **Pantalla apagada:** en `main.js` el `refresh` no dibuja con `document.hidden`; dibuja una vez en
  `visibilitychange`.
- **CSS:** todo `font-size: Npx` es `calc(Npx * var(--bhd-text-scale, 1))` (también las
  `--font-size-*` de las ventanas). Letra grande = clase `bhd-large-text` en `<body>`
  (`--bhd-text-scale: 1.2`, barra inferior 78 px). Al añadir CSS nuevo, seguir la misma forma.
  Animaciones infinitas solo de `transform` / `opacity` (el brillo de Terminar turno es un `::after`);
  `prefers-reduced-motion` las quita.
- **Ajustes del teléfono** (cliente, `config: false`): `largeText`, `keepAwake` (true), `phoneMusic`
  (false). Se cambian en el panel del engranaje (`bhdSettings`, `bhdToggleSetting`) y se aplican sin
  recargar (`applyLargeText`, `updateWakeLock`, `syncPlaylistSounds`).
- **Música:** `mobile-mode.js` sustituye `PlaylistSound.prototype.sync` (de `CONFIG.PlaylistSound.documentClass`):
  sin `phoneMusic` no se crea ni descarga el sonido. Los sonidos de interfaz (dados) siguen.
- **Reconexión** (`connection.js`): Foundry usa socket.io 4.8 con 10 intentos de 500 ms y luego manda a
  `/no`. En vista móvil: `manager.reconnectionAttempts(Infinity)`, espera 1–5 s, `socket.connect()` en
  `visibilitychange` y `online`, reintento manual tras `"io server disconnect"`. Aviso `.bhd-offline`
  en `<body>` (z-index 100000) que bloquea los toques. Foundry recarga solo si estuvo ≥ 5 s sin conexión.
  Sus avisos en inglés de conexión se silencian (`getSilencedNotifications`, también sin consola:
  `console: false`).
- **Notas a salvo:** el borrador también va a `localStorage` (`bhd-companion.notesDraft.<actorId>`,
  `localNotesDraft`); en `_onFirstRender` se recupera y se guarda si difiere de lo guardado.
- **Pantalla de inicio** (`home-screen.js`, en `setup`): manifiesto creado como Blob con URLs absolutas
  (`getRoute`, sirve en local y en The Forge), `apple-touch-icon` y metas `apple-mobile-web-app-*`.
  `beforeinstallprompt` se guarda para el botón "Instalar" (Chrome / Android); en iPhone, instrucciones.
- **Consola:** la vibración del aviso de turno solo con `navigator.userActivation.hasBeenActive`
  (si no, Chrome avisa en la consola).

## Pestaña Mover (decisiones de la etapa 6D)

- **Quién mueve:** el teléfono no tiene mapa (`token.object` no existe y `TokenDocument#_preUpdate` solo
  aplica paredes si `this.rendered`), así que cada toque manda `moveRequest` por `module.bhd-companion`
  solo al DM activo (`recipients`). El servidor añade el id real del remitente como 2.º argumento del
  listener. El DM (cola en serie `gmQueue`) valida con `getMovementBlock`, calcula la casilla con
  `token.object._getShiftedPosition` (igual que las flechas del teclado), comprueba bordes y
  `checkCollision` (tipo de pared de `CONFIG.Token.movement.actions[action].walls`; puertas cerradas
  bloquean) y mueve con `token.move(waypoint, { method: "keyboard" })`. Responde `moveResult` solo al
  jugador; sin respuesta en 5 s → aviso. Requiere que el DM esté conectado y viendo esa escena.
  Si sale "El DM no responde", lo primero: el cliente del DM tiene código viejo → recargarlo (F5).
  Se valoró mover directo desde el teléfono (dueño) con comprobación de paredes propia; se descartó
  por ahora porque no vería regiones ni paredes por altura de otros módulos.
- **Reglas** (`getMovementBlock`, comunes a teléfono y DM): dueño de la ficha, ajuste de mundo
  `lockMovement`, pausa, ficha bloqueada (`token.locked`) y, en combate empezado con esa ficha, solo en su
  turno salvo ajuste `moveOutsideTurn`.
- **Conteo:** flag de la ficha `flags.bhd-companion.movement = { key, path }`. `key` = `combatId.ronda` de
  su último inicio de turno (o `"free"` fuera de combate); si no coincide, el conteo es 0. Pies =
  `token.measureMovementPath(path).distance` (regla de diagonales de la escena). Si el DM movió la ficha a
  mano, se anota un punto con `action: "displace"` (no mide). Velocidad: `movement[token.movementAction]`
  o `walk`. Pasar de la velocidad se permite (Correr), en rojo.
- **Deshacer:** vuelve al punto anterior con `action: "displace"` (sin animación ni paredes) y quita el
  paso; solo si el último punto es un paso y la ficha sigue ahí. Fuera de combate, "Poner a cero".
- **TV:** tras cada paso el DM emite `follow`; los clientes con mapa de esa escena y ajuste de cliente
  `followMoves` (true) hacen `canvas.animatePan` a la ficha.
- **Teléfono:** pestaña `move` (cruceta 3 × 3, `bhdMove` / `bhdMoveUndo` / `bhdMoveReset`), hasta 3 pasos en
  cola; si uno falla se descartan los demás. Pared → aviso, `navigator.vibrate` y `.bhd-shake`.
  Redibuja con `*Token` de fichas propias de la escena activa, `updateScene` (active/grid) y `pauseGame`,
  solo con la pestaña abierta (`app.activeTab`).

## HUD de combate (decisiones de la etapa 6E)

- **Diseño** (`combat.hbs`): arriba, `.bhd-hud-order` con la ronda y una fila horizontal de retratos
  (`.bhd-hud-strip`, en `scrollable` de la parte main; se centra en quien va ahora solo cuando cambia
  el turno, `#syncCombatHud`). Abajo, barra de objetivos, resultado del último uso (`#hudResult`),
  4 bloques (`.bhd-hud-block`, 2 × 2; 4 en fila desde 700 px) y el panel del bloque abierto
  (`#hudBlock`). Colores por bloque con variables `--bhd-block*` en `.bhd-hud-<id>` (sin `color-mix`,
  por iPads viejos). Movimiento lleva a la pestaña Mover.
- **Usado en el turno** (`economy.js`): flag del combatiente `flags.bhd-companion.economy =
  { key, action, bonus, reaction, dash }` (los jugadores pueden cambiar los flags de su combatiente).
  `key` = `combatId.ronda` de su último inicio de turno, igual que el conteo de Mover. Se marca en el
  hook `dnd5e.postUseActivity` (es `Hooks.call`: no devolver `false`) con el tipo de activación de la
  actividad, desde cualquier pestaña; desde el HUD manda el bloque tocado (`#hudUse`: el ataque de
  oportunidad gasta la reacción). "Marcar usada / No la usé" lo cambia a mano. Correr pone `dash`
  y `move-data` dobla la velocidad. Esquivar pone el estado `dodging` y se quita al empezar el
  siguiente turno (no al abrir la vista: `#combatChecked`).
- **Opciones de un bloque** (`combat-hud-data.js`): objetos con actividades de ese
  `activation.type` (armas equipadas, hechizos con `isSpellShown`, rasgos, consumibles, otros
  equipados) reutilizando `prepareRow` y `action-row.hbs` (con `row.hudBlock` → `bhdHudUse`; el toque
  largo y "Más opciones" también pasan por el HUD con `data-hud-block`). Si solo hay una actividad
  de ese tipo se usa `activity.use()` (sin preguntar cuál). Acciones básicas en `BASIC_ACTIONS`:
  mensaje al chat + tirada (Esconderse = Sigilo, Buscar = Percepción) + marcar acción.
- **Objetivos sin mapa** (`targets.js`, desde 0.9.0 solo en modo ligero; con mapa, fichas reales): `game.user.targets` se llena con `PhoneTarget` (id, name,
  actor, document, x/y/w/h, center, `hasDynamicRing: false` porque dnd5e lo lee en `targetToken`).
  dnd5e solo usa `name` y `actor` (`getTargetDescriptors`). Se avisa a las demás pantallas con
  `broadcastActivity({ sceneId, targets })` (sin `sceneId` la TV los ignora, ver
  `Users#handleUserActivity`); se reenvía al reconectar. `pruneTargets` con `deleteToken` y cambio
  de escena activa. Midi QOL lee `game.user.targets` en el cliente que usa el objeto (el teléfono,
  sin mapa): **no probado** (Midi no está instalado en local).
- **¿Necesita objetivo?** (`getTargetNeed`): no si la actividad tiene área (`target.template.type`)
  o `affects.type` es `self` / `space`; sí si es ataque o tiene `affects.type`; cuántos =
  `affects.count` (con `simplifyBonus`) o 1. El selector (`#pickTargets`, `.bhd-picker`, z-index 4)
  devuelve ids, `[]` (sin objetivo) o `null` (cancelar). Con 1 objetivo, tocar la tarjeta ya elige.
  Tarjetas: fichas de la escena activa no ocultas (sin mapa no hay visión), distancia de casilla a
  casilla con `grid.getOffsetRange` + `measurePath` (regla de diagonales de la escena; sin cuadrícula
  o hex, de centro a centro), orden por cercanía, derrotados y uno mismo al final.
- **Resultado:** `#hudResult` se crea en `onPostUseActivity` y se completa en `onActivityRoll`
  (ataque: total, crítico / pifia y por objetivo impacta o falla como la tarjeta de dnd5e; daño:
  total). Impacta / falla solo con el ajuste de mundo `showAttackResult` (nunca se muestra la CA).

## Publicación (etapa 8)

- Repositorio público `https://github.com/BHDVTT/bhd-companion` (gh autenticado como `BHDVTT`).
- Enlace de manifest para The Forge (fijo, siempre la última versión):
  `https://github.com/BHDVTT/bhd-companion/releases/latest/download/module.json`.
- `module.json` lleva `download` = `.../releases/download/v<versión>/module.zip`: al subir `version`,
  cambiar también ese enlace.
- Paquete: `git archive --format=zip -o <scratchpad>/module.zip HEAD` (archivos en la raíz del zip;
  `.gitattributes` excluye CLAUDE.md y archivos de git con `export-ignore`). No usar
  `Compress-Archive` de PowerShell 5.1 (rutas con `\`, fallan en Linux / The Forge).
- Publicar: commit + `git push`, luego
  `gh release create v<versión> <scratchpad>/module.zip module.json --title "v<versión>" --notes "..."`.
  En The Forge la actualización aparece en el gestor de módulos (Update).

## Entorno local

- Datos de Foundry: `C:\Users\Frulo\AppData\Local\FoundryVTT\Data`
- `Data\modules\bhd-companion` es una **unión de directorio (junction)** que apunta a esta
  carpeta del proyecto. Los cambios aquí se ven en Foundry sin copiar nada (recargar con F5).
- **Cuidado:** nunca borrar esa unión con `Remove-Item -Recurse`; podría borrar los archivos
  reales del proyecto. Para quitarla: `cmd /c rmdir "%LOCALAPPDATA%\FoundryVTT\Data\modules\bhd-companion"`.
- dnd5e instalado localmente: 5.3.3.

## Plan por etapas

0. **Esqueleto** ✅ — `module.json`, estructura, `main.js` imprime "BHD Companion cargado".
1. **Detección y contenedor móvil** ✅ (probado en PC con "forzar" y en iPad como jugador) —
   vista a pantalla completa sin mapa, encabezado con el personaje, barra de pestañas
   (Personaje, Acciones, Combate, Inventario, Notas), ajustes del GM (`enabled`, `forceAll`),
   botón para volver a la interfaz normal.
2. **Hoja de personaje** ✅ (probada; incluye tiradas con un toque y botones de vida; 0.3.1 arregla el diseño en iPad) — encabezado (nombre, retrato, PG, CA, velocidad,
   iniciativa), características, salvaciones, habilidades; pestañas inferiores estilo
   D&D Beyond. Se actualiza sola con `updateActor` / `updateItem`.
3. **Acciones** ✅ (0.4.2, probada en iPad: toque rápido, ventaja/desventaja, ventanas compactas, hechizos de pacto) — pestaña Acciones: ataques con armas equipadas,
   hechizos por nivel con espacios, rasgos con usos, consumibles; filtros acción / adicional /
   reacción; buscador de hechizos; `item.use()`; panel con la tarjeta del chat; áreas sin mapa.
4. **Combate en tiempo real** ✅ (0.5.0, probada: iniciativa, aviso de turno, Terminar turno,
   vida aproximada de enemigos, salvaciones de muerte) — pestaña Combate: ronda, orden de
   iniciativa con retratos, ahora / sigue, botón de iniciativa, aviso "¡Es tu turno!" con
   vibración, Terminar turno, estado aproximado de vida de enemigos (ajuste del GM),
   salvaciones de muerte. (El usuario pidió el combate antes que las tiradas.)
   - **Pendiente:** marcar automáticamente un fallo de salvación de muerte cuando un personaje
     con 0 PG recibe daño (dos fallos si es un golpe crítico), con un ajuste del GM para
     desactivarlo si Midi QOL (u otro módulo) ya lo hace y no contar doble.
5. **Inventario, notas y descansos** ✅ (0.6.0, probada; el usuario la pidió antes que las
   tiradas) — pestaña Inventario (por tipo, contenedores, equipar, sintonizar, cantidades,
   monedas, peso), pestaña Notas (notas personales, personalidad, biografía), descanso
   corto / largo en la pestaña Personaje.
6. **Uso real en la tienda** ✅ (0.7.0, probada; el usuario la pidió antes que
   las tiradas) — rendimiento en teléfonos viejos, textos es/en revisados, pantalla encendida,
   reconexión automática, letra grande, añadir a la pantalla de inicio, avisos de consola, README.
   - **6D. Mover desde el teléfono** (0.7.1, probado en iPad: la ficha se mueve; falta probar el resto) — pestaña Mover con cruceta de 8 direcciones,
     paredes y puertas, pies usados / restantes, Deshacer, solo en tu turno (ajustes del GM), elegir
     ficha, la TV sigue la ficha.
   - **6E. HUD de combate** (0.8.0, sin probar) — pestaña Combate rediseñada: retratos en fila,
     bloques Acción / Adicional / Reacción / Movimiento con "usado en este turno", opciones por
     bloque, acciones básicas, selector de objetivos (cercanía, distancia, varios), objetivos de
     Foundry visibles en la TV, resultado impacta / falla y daño.
7. **Tiradas** — ventaja / desventaja adaptadas al móvil para características, salvaciones y
   habilidades (los ataques ya la tienen con la ventana de dnd5e).
8. **Publicación** (0.8.1 publicada en GitHub; falta instalar en The Forge y probar con 5 jugadores) — pruebas con 5 jugadores, repositorio público (GitHub) con `manifest` y
   `download` en `module.json` para instalar en The Forge.
