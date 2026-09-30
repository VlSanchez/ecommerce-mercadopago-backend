import { describe, it, expect } from 'vitest';
import type { Request, Response } from 'express';
import { ok, err, PRODUCT, productUnavailableError } from '../models/index.js';
import type { Product, CatalogError, Result } from '../models/index.js';
import type { CatalogService } from '../services/catalogService.js';
import { createCatalogRouter } from './catalogRouter.js';

/**
 * Pruebas unitarias del router de catálogo (tarea 11.1).
 * Cubren el mapeo de `GET /product` a HTTP 200 (Req. 1.1) y de `PRODUCT_UNAVAILABLE`
 * a HTTP 404 con el cuerpo de error consistente `{ error: { code, message } }` (Req. 1.5).
 *
 * Se invoca el handler del router directamente con objetos req/res simulados, sin
 * levantar un servidor HTTP ni dependencias extra.
 */

/** Captura del estado y del cuerpo enviados por el handler. */
interface CapturedResponse {
  statusCode: number;
  body: unknown;
}

/** Construye un `Response` mínimo que registra `status()` y `json()`. */
function mockResponse(): { res: Response; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 200, body: undefined };
  const res = {
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      captured.body = payload;
      return this;
    },
  } as unknown as Response;
  return { res, captured };
}

/** Crea un Catalog_Service de prueba que retorna un `Result` fijo. */
function stubService(result: Result<Product, CatalogError>): CatalogService {
  return { getProduct: () => result };
}

/**
 * Extrae y ejecuta el handler de `GET /product` del router con el `res` provisto.
 * Localiza la capa de ruta registrada por Express para evitar acoplarse a internals.
 */
function invokeGetProduct(service: CatalogService, res: Response): void {
  const router = createCatalogRouter(service);
  // Express expone las capas registradas en `router.stack`.
  const layer = (router as unknown as {
    stack: Array<{ route?: { path: string; stack: Array<{ handle: Function }> } }>;
  }).stack.find((l) => l.route?.path === '/product');
  if (!layer?.route) throw new Error('no se registró la ruta GET /product');
  const handle = layer.route.stack[0]!.handle;
  handle({} as Request, res, () => {});
}

describe('catalogRouter GET /product', () => {
  it('retorna HTTP 200 con el Product único cuando está disponible (Req. 1.1)', () => {
    const { res, captured } = mockResponse();

    invokeGetProduct(stubService(ok(PRODUCT)), res);

    expect(captured.statusCode).toBe(200);
    expect(captured.body).toEqual(PRODUCT);
  });

  it('mapea PRODUCT_UNAVAILABLE a HTTP 404 con el cuerpo de error consistente (Req. 1.5)', () => {
    const { res, captured } = mockResponse();
    const error = productUnavailableError();

    invokeGetProduct(stubService(err(error)), res);

    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({
      error: { code: error.code, message: error.message },
    });
  });

  it('no devuelve datos parciales del Product ante PRODUCT_UNAVAILABLE (Req. 1.5)', () => {
    const { res, captured } = mockResponse();

    invokeGetProduct(stubService(err(productUnavailableError())), res);

    // El cuerpo sólo contiene la envoltura de error, sin campos del Product.
    const body = captured.body as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['error']);
    expect(body).not.toHaveProperty('id');
    expect(body).not.toHaveProperty('price');
  });
});
