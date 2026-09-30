import { describe, it, expect } from 'vitest';
import type { Request, Response } from 'express';
import {
  ok,
  err,
  invalidSignatureError,
  orderRefNotFoundError,
  paymentInitFailedError,
} from '../models/index.js';
import type { PaymentError, Result } from '../models/index.js';
import type { PaymentService } from '../services/paymentService.js';
import { createWebhookRouter } from './webhookRouter.js';

/**
 * Pruebas unitarias del router de webhook (tarea 11.4).
 * Cubren el mapeo de `POST /` (efectiva `POST /api/webhooks/mercadopago`) a:
 * - HTTP 200 en éxito/descarte idempotente (Req. 6.7),
 * - HTTP 401 ante `INVALID_SIGNATURE` (Req. 6.6),
 * - HTTP 404 ante `ORDER_REF_NOT_FOUND` (Req. 6.4),
 * - HTTP 502 ante otros errores de procesamiento (p. ej. `PAYMENT_INIT_FAILED`),
 * todos con el cuerpo de error consistente `{ error: { code, message } }`.
 *
 * Se invoca el handler del router directamente con objetos req/res simulados, sin
 * levantar un servidor HTTP ni dependencias extra (mismo patrón que catalogRouter.test).
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

/** Crea un Payment_Service de prueba cuyo `handleNotification` retorna un `Result` fijo. */
function stubService(result: Result<void, PaymentError>): PaymentService {
  return {
    startCheckout: async () => {
      throw new Error('no usado en estas pruebas');
    },
    handleNotification: async () => result,
  };
}

/**
 * Extrae y ejecuta el handler POST del router con el `res` provisto. El handler es la
 * ÚLTIMA capa de la ruta `/` (después del middleware `express.raw`).
 */
async function invokePost(
  service: PaymentService,
  res: Response,
  query: Record<string, string> = {},
): Promise<void> {
  const router = createWebhookRouter(service);
  const layer = (router as unknown as {
    stack: Array<{ route?: { path: string; stack: Array<{ handle: Function }> } }>;
  }).stack.find((l) => l.route?.path === '/');
  if (!layer?.route) throw new Error('no se registró la ruta POST /');
  // El handler de negocio es el último de la pila (tras el middleware raw).
  const handle = layer.route.stack[layer.route.stack.length - 1]!.handle;
  const req = { body: Buffer.from('{}'), headers: {}, query } as unknown as Request;
  await handle(req, res, (e?: unknown) => {
    if (e) throw e;
  });
}

/** Query que dispara el procesamiento real (tópico payment + data.id). */
const PAYMENT_QUERY = { type: 'payment', 'data.id': '123' };

describe('webhookRouter POST /api/webhooks/mercadopago', () => {
  it('retorna HTTP 200 con { received: true } en éxito/descarte (Req. 6.7)', async () => {
    const { res, captured } = mockResponse();

    await invokePost(stubService(ok(undefined)), res, PAYMENT_QUERY);

    expect(captured.statusCode).toBe(200);
    expect(captured.body).toEqual({ received: true });
  });

  it('mapea INVALID_SIGNATURE a HTTP 401 (Req. 6.6)', async () => {
    const { res, captured } = mockResponse();
    const error = invalidSignatureError();

    await invokePost(stubService(err(error)), res, PAYMENT_QUERY);

    expect(captured.statusCode).toBe(401);
    expect(captured.body).toEqual({
      error: { code: error.code, message: error.message },
    });
  });

  it('mapea ORDER_REF_NOT_FOUND a HTTP 404 (Req. 6.4)', async () => {
    const { res, captured } = mockResponse();
    const error = orderRefNotFoundError();

    await invokePost(stubService(err(error)), res, PAYMENT_QUERY);

    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({
      error: { code: error.code, message: error.message },
    });
  });

  it('mapea PAYMENT_INIT_FAILED a HTTP 502 como fallback de procesamiento', async () => {
    const { res, captured } = mockResponse();
    const error = paymentInitFailedError();

    await invokePost(stubService(err(error)), res, PAYMENT_QUERY);

    expect(captured.statusCode).toBe(502);
    expect(captured.body).toEqual({
      error: { code: error.code, message: error.message },
    });
  });

  it('ignora tópicos distintos de payment (200 ignored) sin llamar al service', async () => {
    const { res, captured } = mockResponse();
    // Service cuyo handleNotification lanza: si se invocara, el test fallaría, lo que
    // asegura que el filtrado por tópico NO llega a procesar la notificación.
    const failingService: PaymentService = {
      startCheckout: async () => {
        throw new Error('no usado en estas pruebas');
      },
      handleNotification: async () => {
        throw new Error('handleNotification NO debe invocarse para tópicos ignorados');
      },
    };

    await invokePost(failingService, res, { type: 'merchant_order', 'data.id': '999' });

    expect(captured.statusCode).toBe(200);
    expect(captured.body).toEqual({ received: true, ignored: true });
  });
});
