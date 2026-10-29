# BHD Companion

Módulo para **Foundry VTT v13** y el sistema **D&D 5e**, creado para las partidas de
**Battlehammer's Dungeon**.

La idea: la TV de la mesa muestra el mapa, y cada jugador usa **solo su teléfono**. Cuando
un jugador entra a Foundry desde el teléfono, BHD Companion cambia la pantalla por una vista
móvil sencilla (estilo D&D Beyond) con su hoja de personaje, sus acciones y el combate en
tiempo real. El GM y la TV siguen viendo Foundry normal.

Versión actual: **0.7.0**

## Qué hace

**Pestañas de la vista móvil** (barra de abajo):

- **Personaje** — vida (daño, curación, vida temporal), CA, velocidad, iniciativa,
  inspiración, características, salvaciones y habilidades. Un toque = una tirada; el resultado
  aparece unos segundos en el teléfono y completo en el chat (en la TV). Descanso corto y largo.
- **Acciones** — armas equipadas, hechizos por nivel con sus espacios, rasgos con usos y
  consumibles. Filtros (acción / adicional / reacción) y buscador de hechizos.
  Toque = usar y tirar directo. Mantener presionado = ventaja, desventaja o más opciones.
  Las áreas (bola de fuego…) se colocan sobre la ficha del personaje y el DM las mueve en la TV.
- **Combate** — ronda, orden de iniciativa con retratos, quién va ahora y quién sigue, botón
  de iniciativa, aviso a pantalla completa **«¡Es tu turno!»** (con vibración en Android),
  **Terminar turno**, estado aproximado de vida de los enemigos y salvaciones de muerte.
- **Inventario** — objetos por tipo, contenedores, equipar, sintonizar, cantidades, monedas y peso.
- **Notas** — notas personales del jugador (se guardan solas), personalidad y biografía.

**Pensado para la tienda:**

- **Ajustes del teléfono** (botón del engranaje, arriba a la derecha):
  - **Letra grande** — todo el texto y los botones un 20 % más grandes.
  - **Pantalla siempre encendida** — el teléfono no se apaga solo mientras la vista está abierta
    (necesita HTTPS, como en The Forge, y un navegador reciente; iPhone con iOS 16.4 o más).
  - **Música en el teléfono** — apagada por defecto: la música suena solo en la TV y los
    teléfonos no la descargan (ahorra datos y batería).
  - **Añadir a la pantalla de inicio** — instrucciones o botón «Instalar» para abrir la vista
    como si fuera una app.
  - **Volver a la interfaz normal de Foundry** en ese dispositivo.
- **Reconexión automática** — si se cae el Wi-Fi o el teléfono se bloquea, aparece un aviso
  «Sin conexión» y el teléfono sigue intentando reconectar sin rendirse (Foundry, por sí solo,
  se rinde a los 5 segundos). Al volver, la vista se pone al día sola. Las notas que se estaban
  escribiendo se guardan también en el teléfono y no se pierden.
- **Rendimiento en teléfonos viejos** — el mapa no se dibuja en el teléfono; solo se prepara la
  pestaña que se está viendo; con la pantalla apagada no se redibuja nada; animaciones ligeras
  (y ninguna si el teléfono tiene activado «reducir movimiento»).
- **Español e inglés** — todos los textos están en `lang/es.json` y `lang/en.json`; se usa el
  idioma que tenga configurado Foundry.

## Configuración (solo el GM)

En **Configure Settings → BHD Companion**:

- **Activar vista móvil** — enciende o apaga la vista móvil para todos.
- **Forzar vista móvil en cualquier dispositivo (pruebas)** — los jugadores la ven aunque
  usen una computadora.
- **Mostrar estado de vida de los enemigos** — Sano / Herido / Ensangrentado / Casi muerto en la
  pestaña Combate (nunca los números).
- **Usar la interfaz normal en este dispositivo** — ajuste de cada navegador.

## Requisitos

- Foundry VTT v13
- Sistema D&D 5e (dnd5e) 5.0 o superior (probado con 5.3.3)
- Nada más: sin servidores externos ni pagos.

## Instalación

- **Foundry local (pruebas):** la carpeta del módulo está enlazada dentro de `Data\modules`,
  así que aparece sola en la lista de módulos.
- **The Forge:** más adelante se publicará con un enlace de manifest para instalarlo desde
  *Install Module → Manifest URL*.

Para activarlo: entra al mundo como Gamemaster → **Configuración (⚙) → Manage Modules** →
marca **BHD Companion** → **Save Module Settings**.

## Uso con los jugadores

1. Cada jugador abre en su teléfono la dirección del mundo (en The Forge, la de la partida) e
   inicia sesión con su usuario.
2. El GM asigna a cada usuario su personaje (**User Configuration → Character**), o le da
   permiso de dueño sobre él.
3. La vista móvil aparece sola. Recomendado la primera vez: engranaje → **Añadir a la pantalla
   de inicio**. Desde entonces el jugador abre la partida con el icono «BHD» como una app.
   (En iPhone, la app de la pantalla de inicio pide iniciar sesión una vez más.)

## Si algo falla

- **Un jugador se quedó en «Sin conexión»:** revisa que el teléfono siga en el Wi-Fi de la
  tienda. Si tarda, el botón **Recargar ahora** vuelve a cargar la página.
- **La pantalla se sigue apagando:** el ajuste necesita HTTPS (The Forge sí lo tiene; una
  dirección `http://192.168…` en la red local no) y algunos teléfonos lo desactivan en modo
  ahorro de batería.
- **Ver errores:** en la PC, pulsa **F12 → Console**. Los mensajes del módulo empiezan por
  `BHD Companion`.
