import { describe, it, expect } from 'vitest';
import { PRODUCT } from '../src/models/index.js';
import { ok, err, type Result } from '../src/models/index.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';

/**
 * Prueba de scaffolding: verifica que las piezas base del backend están cableadas.
 * Los servicios, store, logger y routers se prueban en sus tareas correspondientes.
 */
describe('scaffolding del backend', () => {
  it('define exactamente un Product con precio 2000 CLP', () => {
    expect(PRODUCT.price).toBe(2000);
    expect(PRODUCT.currency).toBe('CLP');
    expect(PRODUCT.available).toBe(true);
  });

  it('Result soporta variantes de éxito y error', () => {
    const success: Result<number, string> = ok(42);
    const failure: Result<number, string> = err('boom');
    expect(success.ok).toBe(true);
    expect(failure.ok).toBe(false);
    if (success.ok) expect(success.value).toBe(42);
    if (!failure.ok) expect(failure.error).toBe('boom');
  });

  it('loadConfig usa valores por defecto sin env', () => {
    const config = loadConfig({});
    expect(config.port).toBe(3000);
    expect(config.frontendOrigin).toBe('http://localhost:4200');
    expect(config.mpAccessToken).toBe('');
  });

  it('createApp devuelve una app Express invocable', () => {
    const app = createApp(loadConfig({}));
    expect(typeof app).toBe('function');
    expect(typeof app.listen).toBe('function');
  });
});
