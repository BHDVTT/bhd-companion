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
scripts/apps/mobile-app.js   BHDMobileApp (ApplicationV2) — la vista móvil
templates/mobile/*.hbs       partes de la vista: header, main, nav
styles/bhd-companion.css     estilos
lang/es.json, en.json        traducciones
```

## Cómo funciona la vista móvil (decisiones de la etapa 1)

- **Cuándo:** se decide una sola vez en el hook `setup` (documentos listos, mapa e interfaz
  aún sin crear). Condiciones: ajuste `enabled` activo, usuario no GM, ajuste de cliente
  `preferNormal` desactivado, y (`forceAll` o pantalla pequeña: lado corto de la pantalla o
  ancho de ventana < 768 px).
- **Sin mapa:** en `mobile-mode.js` se sustituye `game.settings.get` solo para
  `core.noCanvas`, devolviendo `true` en esta sesión. `Canvas#initialize` sale sin crear WebGL.
  No se guarda en localStorage.
- **Avisos silenciados:** `CONFIG.ui.notifications` se reemplaza por una subclase que descarta
  `ERROR.RESOLUTION.*` (Foundry exige pantalla de PC) e `INFO.SceneViewCanvasDisabled`.
- **Interfaz oculta:** clase `bhd-mobile` en `<body>`; el CSS oculta `#interface`, `#board`,
  `#hud`, `#camera-views`, `#pause`. Las ventanas de Foundry (diálogos) siguen apareciendo
  encima de la vista (z-index 10 < ventanas).
- **App:** `BHDMobileApp` con `window.frame/positioned = false`, pestañas en `TABS.primary`.
  Las pestañas usan la acción propia `bhdTab` (el `_onClickTab` de Foundry usa
  `event.target` y falla al tocar el icono). `close()` ignora cierres salvo `{bhdForce: true}`.
- **Salida / regreso:** el botón del encabezado pone `preferNormal = true` y recarga. En la
  interfaz normal, si el dispositivo podría usar la vista móvil, aparece un botón flotante
  "Vista móvil" que lo revierte.
- Los CSS del núcleo de Foundry están en `@layer`, así que los estilos del módulo ganan.

## Entorno local

- Datos de Foundry: `C:\Users\Frulo\AppData\Local\FoundryVTT\Data`
- `Data\modules\bhd-companion` es una **unión de directorio (junction)** que apunta a esta
  carpeta del proyecto. Los cambios aquí se ven en Foundry sin copiar nada (recargar con F5).
- **Cuidado:** nunca borrar esa unión con `Remove-Item -Recurse`; podría borrar los archivos
  reales del proyecto. Para quitarla: `cmd /c rmdir "%LOCALAPPDATA%\FoundryVTT\Data\modules\bhd-companion"`.
- dnd5e instalado localmente: 5.3.3.

## Plan por etapas

0. **Esqueleto** ✅ — `module.json`, estructura, `main.js` imprime "BHD Companion cargado".
1. **Detección y contenedor móvil** ✅ (código listo, pendiente de prueba del usuario) —
   vista a pantalla completa sin mapa, encabezado con el personaje, barra de pestañas
   (Personaje, Acciones, Combate, Inventario, Notas), ajustes del GM (`enabled`, `forceAll`),
   botón para volver a la interfaz normal.
2. **Hoja de personaje (lectura)** — encabezado (nombre, retrato, PG, CA, velocidad,
   iniciativa), características, salvaciones, habilidades; pestañas inferiores estilo
   D&D Beyond. Se actualiza sola con `updateActor` / `updateItem`.
3. **Tiradas** — tocar una característica, salvación o habilidad tira con dnd5e; ventaja /
   desventaja adaptadas al móvil; resultados al chat (visibles en la TV).
4. **Acciones** — ataques, armas, hechizos y rasgos usando `item.use()`; espacios de hechizo
   y usos limitados.
5. **Combate en tiempo real** — orden de iniciativa, aviso "¡Es tu turno!", terminar turno,
   PG propios (daño/curación), condiciones; escuchando hooks de `Combat`.
6. **Inventario y descansos** — objetos, monedas, descanso corto/largo.
7. **Pulido y publicación** — rendimiento en teléfonos, pruebas con 5 jugadores, repositorio
   público (GitHub) con `manifest` y `download` en `module.json` para instalar en The Forge.
