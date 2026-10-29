# BHD Companion

Módulo para **Foundry VTT v13** y el sistema **D&D 5e**, creado para las partidas de
**Battlehammer's Dungeon**.

La idea: la TV de la mesa muestra el mapa, y cada jugador usa **solo su teléfono**. Cuando
un jugador entra a Foundry desde el teléfono, BHD Companion cambia la pantalla por una vista
móvil sencilla (estilo D&D Beyond) con su hoja de personaje, botones para tirar dados y el
combate en tiempo real.

## Estado actual

Versión 0.1.0 — **esqueleto**. Por ahora el módulo solo escribe `BHD Companion cargado` en la
consola del navegador para confirmar que se instala y carga bien.

## Requisitos

- Foundry VTT v13
- Sistema D&D 5e (dnd5e) 5.0 o superior
- No necesita nada más: sin servidores externos ni pagos.

## Instalación

- **Foundry local (pruebas):** la carpeta del módulo está enlazada dentro de
  `Data\modules`, así que aparece sola en la lista de módulos.
- **The Forge:** más adelante se publicará con un enlace de manifest para instalarlo desde
  *Install Module → Manifest URL*.

## Cómo activarlo

1. Abre Foundry y entra a tu mundo de D&D 5e como Gamemaster.
2. Ve a **Configuración (⚙) → Manage Modules / Gestionar módulos**.
3. Marca **BHD Companion** y pulsa **Save Module Settings**. El mundo se recarga.
4. Pulsa **F12** y abre la pestaña **Console**: debe aparecer `BHD Companion cargado`.
