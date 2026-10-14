/**
 * @file events.js — a ~40-line event emitter.
 *
 * Listener exceptions are swallowed on purpose: a broken UI subscriber must
 * never kill an agent loop. Subscribe defensively.
 */

export class Emitter {
  /** @type {Map<string, Set<Function>>} */
  #listeners = new Map();

  /**
   * Subscribe to an event. Use `'*'` to observe every event.
   * @param {string} type
   * @param {(payload: any) => void} fn
   * @returns {() => void} unsubscribe
   */
  on(type, fn) {
    if (typeof fn !== 'function') throw new TypeError('listener must be a function');
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(fn);
    return () => this.off(type, fn);
  }

  /**
   * @param {string} type
   * @param {(payload: any) => void} fn
   */
  off(type, fn) {
    this.#listeners.get(type)?.delete(fn);
  }

  /**
   * @param {string} type
   * @param {(payload: any) => void} fn
   */
  once(type, fn) {
    const wrapper = (/** @type {any} */ payload) => {
      this.off(type, wrapper);
      fn(payload);
    };
    this.on(type, wrapper);
  }

  /**
   * Emit synchronously to every listener of `type`, then to `'*'` listeners
   * as `(type, payload)`.
   * @param {string} type
   * @param {unknown} payload
   */
  emit(type, payload) {
    const set = this.#listeners.get(type);
    if (set && set.size) {
      for (const fn of [...set]) {
        try {
          fn(payload);
        } catch {
          // A listener must not break the agent loop. Swallow deliberately.
        }
      }
    }
    const all = this.#listeners.get('*');
    if (all && all.size) {
      for (const fn of [...all]) {
        try {
          fn(type, payload);
        } catch {
          // see above
        }
      }
    }
  }

  /** @param {string} [type] omit to clear everything */
  removeAllListeners(type) {
    if (type === undefined) this.#listeners.clear();
    else this.#listeners.delete(type);
  }
}
