import {
  ok,
  err,
  emptyCartError,
  paymentInitFailedError,
  paymentOrderCreationFailedError,
  invalidSignatureError,
  orderRefNotFoundError,
  type Order,
  type PaymentError,
  type Result,
} from '../models/index.js';
import { memoryStore as defaultStore, type MemoryStore } from '../store/memoryStore.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { cartService as defaultCartService, type CartService } from './cartService.js';
import {
  orderService as defaultOrderService,
  type OrderService,
} from './orderService.js';
import {
  mercadoPagoAdapter as defaultAdapter,
  type MercadoPagoAdapter,
} from '../lib/mercadopago.js';

/**
 * Payment_Service — orquesta el inicio del checkout con MercadoPago y (tarea 9.2) el
 * procesamiento de las notificaciones del webhook.
 *
 * Referencia de diseño: design.md → Components and Interfaces / Payment_Service.
 * Esta implementación cubre la tarea 9.1 (`startCheckout`). El método
 * `handleNotification` queda como stub para completarse en la tarea 9.2.
 *
 * Requerimientos cubiertos por `startCheckout`:
 * - 5.1: al iniciar el pago con un Cart que contiene al menos un ítem, se crea una Order
 *   "pending" (vía Order_Service) a partir del contenido del Cart.
 * - 5.2: se construye la Preference vía el adaptador `lib/mercadopago` con
 *   `external_reference` (el `Order.id`), `back_urls` y `notification_url`.
 * - 5.3: con respuesta válida (dentro de los 30s) se retorna
 *   `{ checkoutUrl, orderId, preferenceId }` (el `preferenceId` es requerido por el
 *   frontend para renderizar el Wallet Brick) y se guardan `preferenceId`/`checkoutUrl`
 *   en la Order.
 * - 5.4: si el carrito está vacío o no existe, se retorna `EMPTY_CART` SIN crear ninguna
 *   Order (Property 10).
 * - 5.5: ante error o timeout de MercadoPago, la Order permanece en "pending" sin
 *   `checkoutUrl`, se registra el error vía Logger y se retorna `PAYMENT_INIT_FAILED`.
 */

/** Nombres de operación usados en las entradas de log del Payment_Service (Req. 7.1). */
const OP_START_CHECKOUT = 'payment.startCheckout';
const OP_HANDLE_NOTIFICATION = 'payment.handleNotification';
/** Operación dedicada al log de diagnóstico de la respuesta de la Preference. */
const OP_PREFERENCE_RESPONSE = 'payment.preferenceResponse';

/**
 * Extrae de forma segura el `data.id` (id del recurso/pago) del cuerpo crudo de la
 * notificación del webhook. MercadoPago envía habitualmente `{ "data": { "id": "..." } }`
 * y/o el mismo id en el query string. Aquí trabajamos con el cuerpo JSON crudo; si no es
 * parseable o no trae el id, se retorna `undefined` (la firma se rechazará al no poder
 * construir el manifest, Req. 6.6).
 */
function extractDataId(rawBody: Buffer): string | undefined {
  let payload: unknown;
  try {
    const text = rawBody.toString('utf8');
    if (text.trim() === '') return undefined;
    payload = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const data = record['data'];
  if (typeof data === 'object' && data !== null) {
    const id = (data as Record<string, unknown>)['id'];
    if (typeof id === 'string' && id !== '') return id;
    if (typeof id === 'number') return String(id);
  }
  // Algunas notificaciones traen el id directamente en la raíz (p. ej. `id`).
  const rootId = record['id'];
  if (typeof rootId === 'string' && rootId !== '') return rootId;
  if (typeof rootId === 'number') return String(rootId);
  return undefined;
}

/**
 * Extrae el `Order.id` del `external_reference` de un pago.
 *
 * El `external_reference` es el `Order.id`, por lo que en el caso normal este helper lo
 * devuelve tal cual. Se conserva por compatibilidad/robustez, tolerando un separador `|`:
 * - `undefined` o cadena vacía → `undefined`.
 * - Si contiene `|` → retorna la parte DESPUÉS del último `|`; si esa parte queda vacía,
 *   `undefined`.
 * - Si NO contiene `|` → retorna el valor tal cual (`external_reference = Order.id`).
 *
 * Se exporta para poder probar la extracción de forma aislada.
 */
export function extractOrderId(
  externalReference: string | undefined,
): string | undefined {
  if (externalReference === undefined || externalReference === '') return undefined;
  if (externalReference.includes('|')) {
    const segments = externalReference.split('|');
    const last = segments[segments.length - 1];
    return last === '' ? undefined : last;
  }
  return externalReference;
}

/** Lee una cabecera sin distinguir mayúsculas/minúsculas. */
function readHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

/** Contrato público del Payment_Service. */
export interface PaymentService {
  /**
   * Inicia el checkout para el Cart indicado.
   *
   * Flujo (Req. 5.1-5.5):
   * 1. Valida que el Cart exista y no esté vacío; si no, retorna `EMPTY_CART` sin crear
   *    ninguna Order (Req. 5.4, Property 10).
   * 2. Crea la Order vía Order_Service; si la creación falla, propaga
   *    `ORDER_CREATION_FAILED` sin construir la Preference (Req. 5.6).
   * 3. Construye la Preference vía el adaptador de MercadoPago (timeout 30s).
   * 4. Con respuesta válida retorna `{ checkoutUrl, orderId, preferenceId }` (el
   *    `preferenceId` lo requiere el frontend para renderizar el Wallet Brick) y persiste
   *    `preferenceId`/`checkoutUrl` en la Order (Req. 5.3).
   * 5. Ante error/timeout conserva la Order "pending" sin `checkoutUrl`, registra el
   *    error y retorna `PAYMENT_INIT_FAILED` (Req. 5.5).
   */
  startCheckout(
    cartId: string,
  ): Promise<
    Result<
      { checkoutUrl: string; orderId: string; preferenceId: string },
      PaymentError
    >
  >;
  /**
   * Procesa una notificación del webhook de MercadoPago (tarea 9.2).
   *
   * Flujo (Req. 6.6, 6.4, Property 15):
   * 1. Valida la firma de la notificación vía el adaptador. Si es INVÁLIDA, rechaza sin
   *    modificar ninguna Order, registra la incidencia de autenticación fallida
   *    (`INVALID_SIGNATURE`) y retorna `INVALID_SIGNATURE`.
   * 2. Si la firma es VÁLIDA, consulta el pago referenciado vía el adaptador para obtener
   *    el `external_reference` y el estado real del pago. El `external_reference` es el
   *    `Order.id`; se obtiene vía `extractOrderId` (que lo devuelve tal cual), preservando
   *    la correlación webhook↔Order.
   * 3. Aplica el resultado vía `orderService.applyPaymentResult(orderId, result)`.
   *    Si la Order referenciada no existe, retorna `ORDER_REF_NOT_FOUND` (Req. 6.4).
   * 4. Registra los eventos relevantes vía Logger.
   *
   * @param rawBody cuerpo crudo (Buffer) de la notificación, necesario para la firma HMAC.
   * @param headers cabeceras HTTP de la notificación (incluye `x-signature`/`x-request-id`).
   * @param dataIdFromQuery `data.id` recibido en el QUERY STRING de la URL del webhook.
   *   MercadoPago calcula el HMAC de la firma con este valor, por lo que tiene PRIORIDAD
   *   sobre el `data.id` del body para que el manifest de la firma coincida (Req. 6.6).
   */
  handleNotification(
    rawBody: Buffer,
    headers: Record<string, string>,
    dataIdFromQuery?: string,
  ): Promise<Result<void, PaymentError>>;
}

/** Dependencias inyectables del Payment_Service. Todas tienen valores de producción por defecto. */
export interface PaymentServiceDeps {
  store?: MemoryStore;
  logger?: Logger;
  cartService?: CartService;
  orderService?: OrderService;
  adapter?: MercadoPagoAdapter;
}

/**
 * Crea una instancia del Payment_Service.
 *
 * @param deps dependencias inyectables (store, logger, servicios de dominio y adaptador
 *   de MercadoPago). Por defecto usa las instancias compartidas del proceso. Las pruebas
 *   pueden inyectar dobles o un adaptador mockeado (tarea 9.5).
 */
export function createPaymentService(deps: PaymentServiceDeps = {}): PaymentService {
  const store = deps.store ?? defaultStore;
  const logger = deps.logger ?? defaultLogger;
  const cartService = deps.cartService ?? defaultCartService;
  const orderService = deps.orderService ?? defaultOrderService;
  const adapter = deps.adapter ?? defaultAdapter;

  async function startCheckout(
    cartId: string,
  ): Promise<
    Result<
      { checkoutUrl: string; orderId: string; preferenceId: string },
      PaymentError
    >
  > {
    // Req. 5.4 / Property 10: el Cart debe existir y no estar vacío. Un Cart inexistente
    // o sin ítems retorna EMPTY_CART SIN crear ninguna Order ni construir una Preference.
    const foundCart = cartService.getCart(cartId);
    if (!foundCart.ok || foundCart.value.items.length === 0) {
      const error = emptyCartError();
      logger.logFailure(OP_START_CHECKOUT, error.message, cartId, {
        reason: foundCart.ok ? 'empty_cart' : 'cart_not_found',
      });
      return err(error);
    }

    // Req. 5.1 / 5.6: se crea la Order "pending" vía Order_Service. Si la creación falla,
    // se propaga ORDER_CREATION_FAILED sin construir la Preference.
    const createdOrder = orderService.createOrderFromCart(cartId);
    if (!createdOrder.ok) {
      logger.logFailure(OP_START_CHECKOUT, createdOrder.error.message, cartId, {
        code: createdOrder.error.code,
      });
      return err(paymentOrderCreationFailedError());
    }

    const order = createdOrder.value;

    // Req. 5.2 / 5.3: se construye la Preference vía el adaptador (external_reference =
    // Order.id, back_urls, notification_url, timeout 30s).
    const preference = await adapter.createPreference(order);

    // Req. 5.5: ante error o timeout de MercadoPago, la Order permanece "pending" SIN
    // checkoutUrl. Se registra el error vía Logger y se retorna PAYMENT_INIT_FAILED. No se
    // persiste ninguna URL ni preferenceId (la Order ya está guardada como "pending").
    if (!preference.ok) {
      logger.logFailure(OP_START_CHECKOUT, preference.error.message, order.id, {
        code: preference.error.code,
      });
      logger.logPaymentEvent(order.id, 'pendiente', 'fallo', {
        reason: preference.error.code,
      });
      return err(paymentInitFailedError());
    }

    const { id: preferenceId, init_point: checkoutUrl } = preference.value;

    // Log de diagnóstico de la respuesta de la Preference: registra el payload crudo
    // devuelto por MercadoPago (solo en el camino de éxito) para debug de homologación.
    logger.logSuccess(OP_PREFERENCE_RESPONSE, order.id, {
      preferenceId,
      initPoint: checkoutUrl,
      sandboxInitPoint: preference.value.sandbox_init_point,
      raw: preference.value.raw,
    });

    // Req. 5.3: se guardan preferenceId y checkoutUrl en la Order. Persistimos vía el
    // store; si la persistencia falla, la Order sigue "pending" sin URL: se trata como un
    // fallo de inicio de pago (Req. 5.5) para no reportar un checkout no persistido.
    const updated: Order = {
      ...order,
      preferenceId,
      checkoutUrl,
      updatedAt: new Date().toISOString(),
    };

    try {
      store.saveOrder(updated);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.logFailure(OP_START_CHECKOUT, message, order.id, {
        stage: 'persist_checkout_url',
      });
      logger.logPaymentEvent(order.id, 'pendiente', 'fallo', {
        reason: 'persist_checkout_url',
      });
      return err(paymentInitFailedError());
    }

    // Req. 5.3 / 7.1 / 7.3: se registra el inicio de pago exitoso.
    logger.logSuccess(OP_START_CHECKOUT, order.id, {
      cartId,
      preferenceId,
    });
    logger.logPaymentEvent(order.id, 'pendiente', 'exito', {
      preferenceId,
      checkoutInitiated: true,
    });

    return ok({ checkoutUrl, orderId: order.id, preferenceId });
  }

  async function handleNotification(
    rawBody: Buffer,
    headers: Record<string, string>,
    dataIdFromQuery?: string,
  ): Promise<Result<void, PaymentError>> {
    const signatureHeader = readHeader(headers, 'x-signature');
    const requestId = readHeader(headers, 'x-request-id');
    // MercadoPago envía el `data.id` relevante para la firma en el QUERY STRING de la URL
    // del webhook (no siempre coincide con el `id` del body, que puede ser el id de la
    // notificación). Se PRIORIZA el data.id del query para que el manifest del HMAC
    // coincida; solo se recurre al body como respaldo (Req. 6.6).
    const dataId =
      dataIdFromQuery !== undefined && dataIdFromQuery !== ''
        ? dataIdFromQuery
        : extractDataId(rawBody);

    // Req. 6.6 / Property 15: validar que la notificación provenga de MercadoPago. Si la
    // firma es inválida (ausente, mal formada, secreto no configurado o HMAC que no
    // coincide) se rechaza SIN modificar ninguna Order, se registra la incidencia de
    // autenticación fallida y se retorna INVALID_SIGNATURE.
    const signatureValid = adapter.validateSignature({
      signatureHeader,
      requestId,
      dataId,
    });
    if (!signatureValid) {
      const error = invalidSignatureError();
      logger.logFailure(OP_HANDLE_NOTIFICATION, error.message, dataId, {
        code: error.code,
      });
      return err(error);
    }

    // Req. 6.6: con firma válida se consulta el pago referenciado en MercadoPago para
    // obtener el external_reference (el Order.id) y el estado real del pago. Si la consulta
    // falla, no se puede aplicar el resultado; se registra el fallo y se propaga como un
    // fallo de procesamiento del pago (PAYMENT_INIT_FAILED) sin modificar ninguna Order.
    const paymentId = dataId as string;
    const payment = await adapter.getPayment(paymentId);
    if (!payment.ok) {
      logger.logFailure(OP_HANDLE_NOTIFICATION, payment.error.message, paymentId, {
        code: payment.error.code,
        stage: 'get_payment',
      });
      return err(paymentInitFailedError());
    }

    // El external_reference es el Order.id. Se obtiene con `extractOrderId` (que lo devuelve
    // tal cual cuando no hay separador `|`), preservando la correlación webhook↔Order.
    const orderId = extractOrderId(payment.value.externalReference);
    const status = payment.value.status;

    // Sin external_reference (o sin Order.id extraíble) no es posible correlacionar la
    // notificación con una Order; se trata como referencia de Order no encontrada (Req. 6.4).
    if (orderId === undefined || orderId === '') {
      const error = orderRefNotFoundError();
      logger.logFailure(OP_HANDLE_NOTIFICATION, error.message, paymentId, {
        code: error.code,
        reason: 'missing_external_reference',
      });
      return err(error);
    }

    // Req. 6.1-6.4 / 6.7 / 6.8: aplicar el resultado del pago a la Order vía Order_Service,
    // que implementa el mapeo de estados, la idempotencia y el descarte de resultados
    // desconocidos.
    const applied = orderService.applyPaymentResult(orderId, status);
    if (!applied.ok) {
      // Req. 6.4: la única condición de error propagada por applyPaymentResult es una
      // Order inexistente (RESOURCE_NOT_FOUND). Se mapea a ORDER_REF_NOT_FOUND. Cualquier
      // otro error del Order_Service se refleja igualmente como fallo de procesamiento.
      if (applied.error.code === 'RESOURCE_NOT_FOUND') {
        const error = orderRefNotFoundError();
        logger.logFailure(OP_HANDLE_NOTIFICATION, error.message, orderId, {
          code: error.code,
          paymentId,
        });
        return err(error);
      }
      logger.logFailure(OP_HANDLE_NOTIFICATION, applied.error.message, orderId, {
        code: applied.error.code,
        paymentId,
      });
      return err(paymentInitFailedError());
    }

    // Req. 7.1: la notificación se procesó correctamente (cambio real, descarte idempotente
    // o resultado desconocido descartado, todos casos de éxito de applyPaymentResult). Se
    // registran además `liveMode`/`collectorId` del pago para diagnóstico de homologación
    // (modo productivo vs prueba y a qué cuenta collector pertenece); quedan como
    // `undefined` en el log JSON si el pago no los trajo.
    logger.logSuccess(OP_HANDLE_NOTIFICATION, orderId, {
      paymentId,
      paymentStatus: status,
      orderStatus: applied.value.status,
      liveMode: payment.value.liveMode,
      collectorId: payment.value.collectorId,
    });

    return ok(undefined);
  }

  return { startCheckout, handleNotification };
}

/**
 * Instancia por defecto compartida por el proceso.
 * Los routers/consumidores la usan directamente; las pruebas pueden crear instancias
 * aisladas con `createPaymentService({ ... })` inyectando un adaptador mockeado.
 */
export const paymentService: PaymentService = createPaymentService();
