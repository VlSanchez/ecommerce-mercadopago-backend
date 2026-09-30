import { Router, type NextFunction, type Request, type Response } from 'express';
import { paymentService as defaultPaymentService } from '../services/paymentService.js';
import type { PaymentService } from '../services/paymentService.js';
import type { PaymentError } from '../models/index.js';

/**
 * Router de checkout — inicia el pago con MercadoPago vía HTTP.
 *
 * Referencia de diseño: design.md → Structure (routes/checkout) y Error Handling.
 * Requerimientos:
 * - 5.1: `POST /checkout { cartId }` inicia el pago para un Cart con al menos un ítem;
 *   se crea una Order "pending" y se retorna `{ checkoutUrl, orderId }` con HTTP 200.
 * - 5.4: si el carrito está vacío o no existe, el Payment_Service retorna `EMPTY_CART`;
 *   el router lo mapea a HTTP 400 sin crear ninguna Order.
 * - 5.5: ante error o timeout de MercadoPago, el Payment_Service retorna
 *   `PAYMENT_INIT_FAILED`; el router lo mapea a HTTP 502.
 * - 5.6: si la creación de la Order falla, el Payment_Service retorna
 *   `ORDER_CREATION_FAILED`; el router lo mapea a HTTP 500.
 *
 * Nota de montaje: este router se monta bajo el prefijo `/api` en `app` (tarea 11.4),
 * por lo que la ruta efectiva expuesta al cliente es `POST /api/checkout`. Este archivo
 * NO monta el router en `app.ts`.
 */

/**
 * Mapeo de los códigos de `PaymentError` de `startCheckout` a su código HTTP.
 *
 * Tabla de Error Handling del diseño (Req. 5.4, 5.5, 5.6):
 * - `EMPTY_CART` → 400 (carrito vacío/inexistente).
 * - `ORDER_CREATION_FAILED` → 500 (la Order no pudo crearse).
 * - `PAYMENT_INIT_FAILED` → 502 (MercadoPago falló o excedió el timeout).
 */
const CHECKOUT_ERROR_STATUS: Partial<Record<PaymentError['code'], number>> = {
  EMPTY_CART: 400,
  ORDER_CREATION_FAILED: 500,
  PAYMENT_INIT_FAILED: 502,
};

/** Código HTTP de reserva si `startCheckout` retornara un código no esperado en esta ruta. */
const FALLBACK_ERROR_STATUS = 500;

/**
 * Crea el Router de checkout.
 *
 * @param service Instancia del Payment_Service en la que se delega el inicio del
 *   checkout. Por defecto usa la instancia compartida del proceso; las pruebas pueden
 *   inyectar una aislada (mismo patrón `createX(service)` de los servicios y routers).
 */
export function createCheckoutRouter(service: PaymentService = defaultPaymentService): Router {
  const router = Router();

  /**
   * POST /checkout — inicia el checkout para el Cart indicado (Req. 5.1, 5.4, 5.5, 5.6).
   *
   * - Cuerpo esperado: `{ cartId }`. Un `cartId` ausente se delega igualmente al
   *   Payment_Service, que trata un Cart inexistente/vacío como `EMPTY_CART` (Req. 5.4).
   * - Éxito: HTTP 200 con `{ checkoutUrl, orderId }`.
   * - Errores de negocio: HTTP 400/500/502 con el cuerpo de error consistente de la app
   *   `{ error: { code, message } }`.
   * - Errores inesperados (excepciones): se delegan a `next(err)` para que el manejador
   *   de errores global (tarea 11.4) responda 500 genérico.
   */
  router.post('/checkout', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cartId: string = req.body?.cartId;

      const result = await service.startCheckout(cartId);

      // Req. 5.4 / 5.5 / 5.6: mapeo de los errores de negocio a su código HTTP.
      if (!result.ok) {
        const { code, message } = result.error;
        const status = CHECKOUT_ERROR_STATUS[code] ?? FALLBACK_ERROR_STATUS;
        res.status(status).json({ error: { code, message } });
        return;
      }

      // Req. 5.1: checkout iniciado; se retorna la URL de pago y el id de la Order.
      res.status(200).json(result.value);
    } catch (err) {
      // Req. 5.x: cualquier excepción no esperada se delega al manejador de errores global.
      next(err);
    }
  });

  return router;
}

/**
 * Instancia por defecto del router configurada con el Payment_Service compartido.
 * Se usa para montarlo en `app` (tarea 11.4); las pruebas pueden crear routers
 * aislados con `createCheckoutRouter(servicioPersonalizado)`.
 */
export const checkoutRouter: Router = createCheckoutRouter();
