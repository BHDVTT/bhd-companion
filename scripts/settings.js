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
}
