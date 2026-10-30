import { MODULE_ID } from "./constants.js";

/**
 * Registra las configuraciones del módulo. Se llama en el hook "init".
 */
export function registerSettings() {
  // Interruptor general (lo controla el GM para todo el mundo).
  game.settings.register(MODULE_ID, "enabled", {
    name: "BHD.Settings.Enabled.Name",
    hint: "BHD.Settings.Enabled.Hint",
    scope: "world",
    config: true,
    type: new foundry.data.fields.BooleanField({ initial: true }),
    requiresReload: true
  });

  // Modo de pruebas: vista móvil para todos los jugadores, aunque usen una PC.
  game.settings.register(MODULE_ID, "forceAll", {
    name: "BHD.Settings.ForceAll.Name",
    hint: "BHD.Settings.ForceAll.Hint",
    scope: "world",
    config: true,
    type: new foundry.data.fields.BooleanField({ initial: false }),
    requiresReload: true
  });

  // Pestaña Combate: estado aproximado de vida (Sano, Herido...) de los enemigos.
  game.settings.register(MODULE_ID, "showEnemyHealth", {
    name: "BHD.Settings.ShowEnemyHealth.Name",
    hint: "BHD.Settings.ShowEnemyHealth.Hint",
    scope: "world",
    config: true,
    type: new foundry.data.fields.BooleanField({ initial: true }),
    onChange: () => game.modules.get(MODULE_ID).api?.app?.render()
  });

  // HUD de combate: decir al jugador si su ataque impactó o falló (nunca la CA del objetivo).
  game.settings.register(MODULE_ID, "showAttackResult", {
    name: "BHD.Settings.ShowAttackResult.Name",
    hint: "BHD.Settings.ShowAttackResult.Hint",
    scope: "world",
    config: true,
    type: new foundry.data.fields.BooleanField({ initial: true })
  });

  // Pestaña Mover: bloquear el movimiento desde los teléfonos para todos.
  game.settings.register(MODULE_ID, "lockMovement", {
    name: "BHD.Settings.LockMovement.Name",
    hint: "BHD.Settings.LockMovement.Hint",
    scope: "world",
    config: true,
    type: new foundry.data.fields.BooleanField({ initial: false }),
    onChange: () => game.modules.get(MODULE_ID).api?.app?.render()
  });

  // Pestaña Mover: en combate, dejar moverse también fuera del propio turno.
  game.settings.register(MODULE_ID, "moveOutsideTurn", {
    name: "BHD.Settings.MoveOutsideTurn.Name",
    hint: "BHD.Settings.MoveOutsideTurn.Hint",
    scope: "world",
    config: true,
    type: new foundry.data.fields.BooleanField({ initial: false }),
    onChange: () => game.modules.get(MODULE_ID).api?.app?.render()
  });

  // En las pantallas con mapa (la TV): centrar la vista en la ficha que se mueve desde un teléfono.
  game.settings.register(MODULE_ID, "followMoves", {
    name: "BHD.Settings.FollowMoves.Name",
    hint: "BHD.Settings.FollowMoves.Hint",
    scope: "client",
    config: true,
    type: new foundry.data.fields.BooleanField({ initial: true })
  });

  // Vista de cada dispositivo: automática (teléfonos y tabletas), siempre móvil o nunca.
  // El enlace con ?bhd=mobile / ?bhd=normal / ?bhd=auto manda sobre este ajuste en esa pestaña.
  // El GM nunca ve la vista móvil, elija lo que elija.
  game.settings.register(MODULE_ID, "viewMode", {
    name: "BHD.Settings.ViewMode.Name",
    hint: "BHD.Settings.ViewMode.Hint",
    scope: "client",
    config: true,
    type: new foundry.data.fields.StringField({
      required: true,
      blank: false,
      initial: "auto",
      choices: {
        auto: "BHD.Settings.ViewMode.Auto",
        mobile: "BHD.Settings.ViewMode.Mobile",
        normal: "BHD.Settings.ViewMode.Normal"
      }
    }),
    requiresReload: true,
    // Elegir "Siempre móvil" deshace un "Volver a la interfaz normal" anterior.
    onChange: value => {
      if ( (value === "mobile") && game.settings.get(MODULE_ID, "preferNormal") ) {
        game.settings.set(MODULE_ID, "preferNormal", false);
      }
    }
  });

  // Preferencia de cada dispositivo: usar la interfaz normal de Foundry en lugar de la vista móvil.
  game.settings.register(MODULE_ID, "preferNormal", {
    name: "BHD.Settings.PreferNormal.Name",
    hint: "BHD.Settings.PreferNormal.Hint",
    scope: "client",
    config: true,
    type: new foundry.data.fields.BooleanField({ initial: false }),
    requiresReload: true
  });

  // Preferencias del teléfono. Se cambian desde el botón de ajustes de la vista móvil
  // (en la interfaz normal están ocultas: no hacen nada fuera de la vista móvil).
  game.settings.register(MODULE_ID, "largeText", {
    name: "BHD.Settings.LargeText.Name",
    hint: "BHD.Settings.LargeText.Hint",
    scope: "client",
    config: false,
    type: new foundry.data.fields.BooleanField({ initial: false })
  });

  game.settings.register(MODULE_ID, "keepAwake", {
    name: "BHD.Settings.KeepAwake.Name",
    hint: "BHD.Settings.KeepAwake.Hint",
    scope: "client",
    config: false,
    type: new foundry.data.fields.BooleanField({ initial: true })
  });

  game.settings.register(MODULE_ID, "phoneMusic", {
    name: "BHD.Settings.PhoneMusic.Name",
    hint: "BHD.Settings.PhoneMusic.Hint",
    scope: "client",
    config: false,
    type: new foundry.data.fields.BooleanField({ initial: false })
  });
}
