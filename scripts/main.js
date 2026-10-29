/**
 * BHD Companion — punto de entrada del módulo.
 * Etapa 0: solo confirma que el módulo carga.
 */

export const MODULE_ID = "bhd-companion";

Hooks.once("init", () => {
  console.log("BHD Companion cargado");
});
