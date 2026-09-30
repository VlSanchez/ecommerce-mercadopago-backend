import { describe, it, expect } from 'vitest';
import type { Express } from 'express';
import { createApp } from './app.js';

/**
 * Prueba mínima de arranque y montaje (tarea 11.4).
 *
 * Verifica que `createApp` construye la app sin lanzar y que los routers de dominio
 * quedan montados en las rutas efectivas esperadas. No levanta un servidor HTTP ni
 * cubre el flujo end-to-end (esa es la tarea 11.5 con supertest); aquí sólo se inspecciona
 * la tabla de rutas registradas por Express para confirmar el cableado.
 */

/** Forma mínima de una capa del router raíz de Express que interesa inspeccionar. */
interface ExpressLayer {
  name: string;
  regexp: RegExp;
  route?: { path: string };
  handle?: { stack?: ExpressLayer[] };
}

/**
 * Recorre `app._router.stack` y devuelve `true` si existe alguna capa cuyo patrón de
 * montaje coincide con el prefijo indicado (p. ej. un router montado en `/api/cart`).
 */
function hasMountAt(app: Express, prefix: string): boolean {
  const stack = (app as unknown as { _router: { stack: ExpressLayer[] } })._router.stack;
  return stack.some((layer) => layer.regexp.test(prefix));
}

describe('createApp — arranque y montaje de routers (tarea 11.4)', () => {
  it('construye la app sin lanzar', () => {
    expect(() => createApp()).not.toThrow();
  });

  it('registra un manejador de errores global de 4 argumentos como última capa', () => {
    const app = createApp();
    const stack = (app as unknown as { _router: { stack: Array<{ handle: Function }> } })
      ._router.stack;
    const last = stack[stack.length - 1]!;
    // Un manejador de errores en Express se identifica por su aridad de 4 (err, req, res, next).
    expect(last.handle.length).toBe(4);
  });

  it('monta los routers de dominio en sus prefijos (/api, /api/cart, /api/webhooks/mercadopago)', () => {
    const app = createApp();
    expect(hasMountAt(app, '/api/product')).toBe(true);
    expect(hasMountAt(app, '/api/cart')).toBe(true);
    expect(hasMountAt(app, '/api/checkout')).toBe(true);
    expect(hasMountAt(app, '/api/webhooks/mercadopago')).toBe(true);
  });
});
