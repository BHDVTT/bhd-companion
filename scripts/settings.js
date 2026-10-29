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
