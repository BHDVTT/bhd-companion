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

## Estructura

```
module.json              manifiesto del módulo
scripts/main.js          punto de entrada (esmodule)
styles/bhd-companion.css estilos
templates/               plantillas Handlebars (.hbs)
lang/es.json, en.json    traducciones
```

## Entorno local

- Datos de Foundry: `C:\Users\Frulo\AppData\Local\FoundryVTT\Data`
- `Data\modules\bhd-companion` es una **unión de directorio (junction)** que apunta a esta
  carpeta del proyecto. Los cambios aquí se ven en Foundry sin copiar nada (recargar con F5).
- **Cuidado:** nunca borrar esa unión con `Remove-Item -Recurse`; podría borrar los archivos
  reales del proyecto. Para quitarla: `cmd /c rmdir "%LOCALAPPDATA%\FoundryVTT\Data\modules\bhd-companion"`.
- dnd5e instalado localmente: 5.3.3.

## Plan por etapas

0. **Esqueleto** ✅ — `module.json`, estructura, `main.js` imprime "BHD Companion cargado".
1. **Detección y contenedor móvil** — detectar teléfono (ancho de pantalla / táctil) más un
   ajuste por usuario para forzar vista móvil o normal. Si aplica: ocultar la UI de Foundry
   (canvas, barras laterales) y montar una ApplicationV2 a pantalla completa con un
   "Hola, {jugador}" y su personaje asignado.
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
