import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { paymentService as defaultPaymentService } from '../services/paymentService.js';
import type { PaymentService } from '../services/paymentService.js';
import type { PaymentError } from '../models/index.js';
import { logger } from '../lib/logger.js';

/**
 * Router de webhook — recibe las notificaciones de pago de MercadoPago vía HTTP y delega
 * en `Payment_Service.handleNotification`.
 *
 * Referencia de diseño: design.md → Structure (routes/webhooks) y Error Handling.
 * Requerimientos:
 * - 6.6: la firma de la notificación se valida en el Payment_Service; si es inválida se
 *   retorna `INVALID_SIGNATURE`, que este router mapea a HTTP 401 sin modificar ninguna
 *   Order.
 * - 6.4: si la notificación referencia una Order inexistente, el Payment_Service retorna
 *   `ORDER_REF_NOT_FOUND`, que este router mapea a HTTP 404.
 * - 6.7: los casos de éxito (cambio de estado real, descarte idempotente o resultado
 *   desconocido descartado) retornan `ok`; este router los mapea a HTTP 200.
 *
 * Cuerpo crudo (raw body): `handleNotification` necesita el cuerpo SIN parsear (Buffer)
 * para validar la firma HMAC de MercadoPago. Por eso este router aplica el middleware
 * `express.raw` con `type` comodín EN SU PROPIA RUTA, de modo que `req.body` sea un
 * Buffer aquí, mientras el resto de la app conserva `express.json()`. Se monta antes del
 * parser JSON global en `app.ts` para que este último no consuma el stream (ver app.ts).
 *
 * Nota de montaje: este router se monta bajo el prefijo `/api/webhooks/mercadopago` en
 * `app` (tarea 11.4), con la ruta definida en `/`, por lo que la ruta efectiva expuesta
 * a MercadoPago es `POST /api/webhooks/mercadopago`. Este archivo NO monta el router en
 * `app.ts`.
 *
 * Filtrado por tópico: MercadoPago envía a este MISMO endpoint notificaciones de varios
 * tópicos (payment, merchant_order, etc.), indicados en el query param `type`. Las de
 * tópicos distintos de `payment` llegan sin `data.id` y con otro esquema de firma, lo que
 * generaría 401 (INVALID_SIGNATURE) y reintentos innecesarios. Por eso este router SOLO
 * intenta validar la firma y procesar cuando la notificación es realmente de pago (tópico
 * `payment` con `data.id`); cualquier otra cosa se confirma con HTTP 200 e `ignored: true`
 * sin procesar, para evitar reintentos y no ensuciar el log con 401.
 */

/**
 * Mapeo de los códigos de `PaymentError` de `handleNotification` a su código HTTP.
 *
 * Tabla de Error Handling del diseño (Req. 6.6, 6.4):
 * - `INVALID_SIGNATURE` → 401 (la notificación no pudo autenticarse).
 * - `ORDER_REF_NOT_FOUND` → 404 (la Order referenciada no existe).
 * - Cualquier otro código (p. ej. `PAYMENT_INIT_FAILED` al consultar el pago) → 502
 *   (fallo al procesar la notificación con la pasarela de pago).
 */
const WEBHOOK_ERROR_STATUS: Partial<Record<PaymentError['code'], number>> = {
  INVALID_SIGNATURE: 401,
  ORDER_REF_NOT_FOUND: 404,
  PAYMENT_INIT_FAILED: 502,
};

/** Código HTTP de reserva si `handleNotification` retornara un código no esperado. */
const FALLBACK_ERROR_STATUS = 500;

/**
 * Middleware que expone el cuerpo crudo como Buffer para esta ruta específica.
 * El `type` comodín asegura que se capture el cuerpo sin importar el `Content-Type` que
 * envíe MercadoPago, dejando `req.body` como Buffer para la validación de firma.
 */
const rawBodyParser = express.raw({ type: '*/*' });

/**
 * Crea el Router de webhook.
 *
 * @param service Instancia del Payment_Service en la que se delega el procesamiento de
 *   la notificación. Por defecto usa la instancia compartida del proceso; las pruebas
 *   pueden inyectar una aislada (mismo patrón `createX(service)` de los servicios y
 *   routers).
 */
export function createWebhookRouter(service: PaymentService = defaultPaymentService): Router {
  const router = Router();

  /**
   * POST / — recibe la notificación de MercadoPago (Req. 6.4, 6.6, 6.7).
   *
   * - `req.body` es un Buffer con el cuerpo crudo (necesario para la firma HMAC).
   * - Filtrado por tópico: solo se procesa el tópico `payment` (query param `type`). Las
   *   notificaciones de otros tópicos (p. ej. `merchant_order`), o las que no traen ni
   *   tópico `payment` ni `data.id`, se confirman con HTTP 200 `{ received: true,
   *   ignored: true }` SIN validar firma ni procesar, para evitar 401/reintentos.
   * - Éxito: HTTP 200 con `{ received: true }` (incluye descartes idempotentes, Req. 6.7).
   * - Errores de negocio: HTTP 401/404/502 con el cuerpo de error consistente de la app
   *   `{ error: { code, message } }`.
   * - Errores inesperados (excepciones): se delegan a `next(err)` para que el manejador
   *   de errores global (tarea 11.4) responda 500 genérico.
   */
  router.post('/', rawBodyParser, async (req: Request, res: Response, next: NextFunction) => {
    try {
      // `express.raw` deja `req.body` como Buffer; si por algún motivo no lo fuera
      // (cuerpo vacío u otro parser), se normaliza a un Buffer vacío para que la
      // validación de firma decida (la firma se rechazará al no poder construir el manifest).
      const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const headers = req.headers as Record<string, string>;

      // MercadoPago calcula el HMAC de la firma con el `data.id` que viaja en el QUERY
      // STRING de la URL del webhook (p. ej. `?data.id=181415261004&type=payment`). En
      // Express ese parámetro se accede como `req.query['data.id']`. Se pasa al servicio
      // para que el manifest de la firma coincida (Req. 6.6).
      const dataIdFromQuery =
        typeof req.query['data.id'] === 'string'
          ? (req.query['data.id'] as string)
          : undefined;

      // Tópico de la notificación. MercadoPago lo envía en el query param `type`
      // (p. ej. `?type=payment&data.id=...`).
      const topic =
        typeof req.query['type'] === 'string' ? (req.query['type'] as string) : undefined;

      // Log de diagnóstico del webhook: registra query, tópico, headers de firma y body
      // crudo para debug de homologación. Se emite ANTES del filtrado por tópico y de la
      // validación de firma para no perder información (no cambia lógica ni códigos HTTP).
      logger.logSuccess('webhook.received', dataIdFromQuery, {
        query: req.query,
        topic,
        dataId: dataIdFromQuery,
        // headers relevantes (no logueamos todo para no ensuciar, pero incluimos los de firma)
        xSignature: headers['x-signature'],
        xRequestId: headers['x-request-id'],
        contentType: headers['content-type'],
        userAgent: headers['user-agent'],
        // body crudo parseado a texto/JSON para inspección
        rawBody: rawBody.toString('utf8'),
      });

      // Filtrado por tópico: SOLO se procesa el tópico `payment`. El resto se confirma con
      // HTTP 200 para que MercadoPago no reintente y no ensuciar el log con 401.
      // - Tópico definido y distinto de `payment` → ignorar.
      // - Sin tópico `payment` ni `data.id` (nada procesable) → ignorar.
      // Solo se procede a validar firma + procesar cuando es realmente una notificación de
      // pago: tópico `payment`, o (por compatibilidad) sin tópico pero con `data.id`.
      const isPaymentTopic = topic === 'payment';
      const isLegacyPaymentNotification = topic === undefined && dataIdFromQuery !== undefined;
      if (!isPaymentTopic && !isLegacyPaymentNotification) {
        res.status(200).json({ received: true, ignored: true });
        return;
      }

      const result = await service.handleNotification(rawBody, headers, dataIdFromQuery);

      // Req. 6.4 / 6.6: mapeo de los errores de negocio a su código HTTP.
      if (!result.ok) {
        const { code, message } = result.error;
        const status = WEBHOOK_ERROR_STATUS[code] ?? FALLBACK_ERROR_STATUS;
        res.status(status).json({ error: { code, message } });
        return;
      }

      // Req. 6.7: notificación procesada (éxito o descarte idempotente/desconocido) → 200.
      res.status(200).json({ received: true });
    } catch (err) {
      // Req. 6.x: cualquier excepción no esperada se delega al manejador de errores global.
      next(err);
    }
  });

  return router;
}

/**
 * Instancia por defecto del router configurada con el Payment_Service compartido.
 * Se usa para montarlo en `app` (tarea 11.4); las pruebas pueden crear routers
 * aislados con `createWebhookRouter(servicioPersonalizado)`.
 */
export const webhookRouter: Router = createWebhookRouter();
