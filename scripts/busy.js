/**
 * Botones "ocupados" que siempre se liberan.
 *
 * Mientras se hace una tirada o un uso, la vista no deja empezar otro (para no gastar dos veces). Antes
 * eso era un simple sí / no: si la promesa de dnd5e, de Midi o del DM no terminaba nunca (respuesta perdida
 * al cortarse el Wi-Fi, una ventana cerrada por otro módulo...), el botón se quedaba gris para siempre.
 * Ahora cada bloqueo tiene un tiempo máximo: pasado ese tiempo se libera solo y se avisa. Si el jugador está
 * contestando algo (una ventana de dnd5e, el selector de objetivos, colocar un área), se espera un poco más.
 */

/** Tiempo máximo que un botón queda ocupado (ms). */
export const BUSY_TIMEOUT_MS = 10 * 1000;

/** Aunque el jugador esté contestando una ventana, el bloqueo no dura más de esto (ms). */
const BUSY_HARD_LIMIT_MS = 2 * 60 * 1000;

/**
 * Espera una promesa como mucho `ms` milisegundos.
 * @param {Promise|any} promise
 * @param {number} ms
 * @param {any|Function} fallback  Lo que se devuelve si se acaba el tiempo (si es función, su resultado).
 * @returns {Promise<any>}
 */
export function withTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve((typeof fallback === "function") ? fallback() : fallback), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Bloqueos con nombre ("roll", "use"...). Cada uno tiene su temporizador.
 */
export class BusyLocks {
  /**
   * @param {object} options
   * @param {() => boolean} [options.isWaiting]  ¿El jugador está contestando algo? Entonces se espera más.
   * @param {(lock: object) => void} [options.onTimeout]  Se llama al liberar un bloqueo por tiempo.
   */
  constructor({ isWaiting, onTimeout }={}) {
    this.#isWaiting = isWaiting ?? (() => false);
    this.#onTimeout = onTimeout ?? (() => {});
  }

  #isWaiting;
  #onTimeout;

  /** @type {Map<string, object>} */
  #locks = new Map();

  /**
   * ¿Está ocupado?
   * @param {string} name
   * @returns {boolean}
   */
  isBusy(name) {
    return this.#locks.has(name);
  }

  /**
   * Ocupa un bloqueo. Devuelve null si ya estaba ocupado.
   * @param {string} name
   * @param {object} [options]
   * @param {HTMLElement} [options.button]  Botón tocado: se pone gris mientras dure.
   * @param {string} [options.label]        Qué se está haciendo (para el aviso y la consola).
   * @param {number} [options.timeout]      Tiempo máximo (ms).
   * @returns {object|null}
   */
  acquire(name, { button, label="", timeout=BUSY_TIMEOUT_MS }={}) {
    if ( this.#locks.has(name) ) return null;
    const lock = { name, button, label, started: Date.now(), released: false, timedOut: false, timer: null };
    this.#locks.set(name, lock);
    button?.classList.add("bhd-rolling");
    const check = () => {
      if ( lock.released ) return;
      const elapsed = Date.now() - lock.started;
      if ( this.#isWaiting() && (elapsed < BUSY_HARD_LIMIT_MS) ) {
        lock.timer = setTimeout(check, 2000);
        return;
      }
      lock.timedOut = true;
      console.warn(`BHD Companion | "${label || name}" no terminó en ${Math.round(elapsed / 1000)} s: botón liberado`);
      this.release(lock);
      try {
        this.#onTimeout(lock);
      } catch(err) {
        console.error(err);
      }
    };
    lock.timer = setTimeout(check, timeout);
    return lock;
  }

  /**
   * Libera un bloqueo (solo si sigue siendo el actual; liberar dos veces no hace nada).
   * @param {object|null} lock
   */
  release(lock) {
    if ( !lock || lock.released ) return;
    lock.released = true;
    clearTimeout(lock.timer);
    if ( this.#locks.get(lock.name) === lock ) this.#locks.delete(lock.name);
    lock.button?.classList.remove("bhd-rolling");
  }

  /** Libera todos (botón Reconectar). */
  releaseAll() {
    for ( const lock of [...this.#locks.values()] ) this.release(lock);
  }
}
