import {
  ok,
  err,
  orderCreationFailedError,
  type CartItem,
  type Order,
  type OrderStatus,
  type OrderError,
  type NotFoundError,
  type Result,
} from '../models/index.js';
import { memoryStore as defaultStore, type MemoryStore } from '../store/memoryStore.js';
import {
  logger as defaultLogger,
  type Logger,
  type PaymentLogStatus,
} from '../lib/logger.js';

/**
 * Order_Service — crea y consulta las órdenes de compra en memoria.
 *
 * Referencia de diseño: design.md → Components and Interfaces / Order_Service y
 * Data Models / Order. Cubre la tarea 7.1 (creación y consulta de órdenes) y la
 * tarea 7.2 (aplicación del resultado de pago mediante máquina de estados).
 *
 * Requerimientos:
 * - 5.1: al iniciar el pago con un Cart que contiene al menos un ítem, se crea una
 *   Order con estado "pending" a partir del contenido del Cart.
 * - 5.2: la Order lleva el monto total en CLP como entero sin decimales entre 1 y
 *   999999999; `createOrderFromCart` guarda ese `amount` en la Order (la construcción
 *   de la Preference corresponde al Payment_Service).
 * - 5.6: si la creación de la Order falla, se retorna `ORDER_CREATION_FAILED` y no se
 *   construye una Preference de MercadoPago (este servicio nunca la construye).
 * - 4.5: `getOrder` retorna `RESOURCE_NOT_FOUND` para un id inexistente sin alterar el
 *   estado.
 * - 6.1/6.2/6.3: `applyPaymentResult` mapea el resultado de pago al estado de la Order
 *   (`approved→paid`, `rejected→rejected`, `pending→pending`).
 * - 6.4: una notificación que referencia una Order inexistente no modifica ningún
 *   estado, registra la incidencia y retorna `RESOURCE_NOT_FOUND`.
 * - 6.5: cada cambio real de estado se registra vía Logger con id, estado anterior,
 *   estado nuevo y marca temporal.
 * - 6.7: aplicar el mismo resultado dos veces deja la Order en el mismo estado; una
 *   notificación que coincide con el estado final actual se descarta sin modificar.
 * - 6.8: un resultado desconocido no modifica el estado y se registra la incidencia
 *   como resultado de pago desconocido.
 * - 7.1: cada operación se registra vía Logger con su resultado en `{exito, fallo}`.
 */

/** Monto mínimo permitido para una Order, entero CLP (Req. 5.2). */
export const MIN_ORDER_AMOUNT = 1;

/** Monto máximo permitido para una Order, entero CLP (Req. 5.2). */
export const MAX_ORDER_AMOUNT = 999999999;

/** Nombres de operación usados en las entradas de log del Order_Service (Req. 7.1). */
const OP_CREATE = 'order.createOrderFromCart';
const OP_GET = 'order.getOrder';
const OP_APPLY = 'order.applyPaymentResult';

/**
 * Resultados de pago conocidos que provienen de MercadoPago (Req. 6.1, 6.2, 6.3).
 * Cualquier valor distinto se considera desconocido (Req. 6.8).
 */
export type PaymentResult = 'approved' | 'rejected' | 'pending';

/**
 * Mapea un resultado de pago conocido al estado destino de la Order (Req. 6.1-6.3):
 * `approved→paid`, `rejected→rejected`, `pending→pending`.
 */
const RESULT_TO_STATUS: Record<PaymentResult, OrderStatus> = {
  approved: 'paid',
  rejected: 'rejected',
  pending: 'pending',
};

/**
 * Código de log de la incidencia por resultado de pago desconocido (Req. 6.8).
 * Ver design.md → Error Handling / Mapeo de errores: `UNKNOWN_PAYMENT_RESULT`.
 */
const UNKNOWN_PAYMENT_RESULT = 'UNKNOWN_PAYMENT_RESULT';

/** Traduce el estado destino de la Order al vocabulario de log de pago (Req. 7.3). */
const STATUS_TO_PAYMENT_LOG: Record<OrderStatus, PaymentLogStatus> = {
  pending: 'pendiente',
  paid: 'aprobado',
  rejected: 'rechazado',
};

/** Determina si un resultado arbitrario es uno de los resultados de pago conocidos. */
function isKnownPaymentResult(result: string): result is PaymentResult {
  return result === 'approved' || result === 'rejected' || result === 'pending';
}

/** Contrato público del Order_Service (subconjunto implementado en la tarea 7.1). */
export interface OrderService {
  /**
   * Crea una Order en estado "pending" a partir del Cart indicado (Req. 5.1). El
   * `cartSnapshot` copia los ítems y el total del Cart, y `amount` es el total en CLP
   * como entero en `[1, 999999999]` (Req. 5.2). Si el Cart no existe o está vacío se
   * trata como un fallo de creación: se retorna `ORDER_CREATION_FAILED` y no se crea
   * ninguna Order ni se construye una Preference (Req. 5.6). Registra la operación
   * vía Logger (Req. 7.1).
   */
  createOrderFromCart(cartId: string): Result<Order, OrderError>;
  /**
   * Retorna la Order indicada (Req. 4.5). Si la Order no existe, retorna
   * `RESOURCE_NOT_FOUND` sin alterar el estado.
   */
  getOrder(orderId: string): Result<Order, NotFoundError>;
  /**
   * Aplica el resultado de un pago a la Order indicada siguiendo la máquina de estados
   * del diseño (design.md → Data Models / Order).
   *
   * Reglas:
   * - Mapea `approved→paid`, `rejected→rejected`, `pending→pending` (Req. 6.1-6.3).
   * - Solo aplica un cambio si el estado destino difiere del actual; cada cambio real
   *   se registra vía Logger con id, estado anterior, estado nuevo y marca temporal
   *   (Req. 6.5).
   * - Es idempotente: una notificación cuyo resultado ya coincide con el estado final
   *   actual se descarta sin modificar la Order (Req. 6.7).
   * - Un resultado desconocido (distinto de approved/rejected/pending) no modifica el
   *   estado y registra la incidencia como resultado de pago desconocido (Req. 6.8).
   * - Si la Order no existe, retorna `RESOURCE_NOT_FOUND` sin modificar ningún estado y
   *   registra la incidencia (Req. 6.4).
   *
   * En todos los casos de éxito (cambio real, descarte idempotente o resultado
   * desconocido) retorna la Order resultante sin modificar cuando corresponde.
   */
  applyPaymentResult(
    orderId: string,
    result: PaymentResult | string,
  ): Result<Order, OrderError | NotFoundError>;
}

/** Copia defensiva de los ítems del carrito para el snapshot de la Order. */
function snapshotItems(items: CartItem[]): CartItem[] {
  return items.map((item) => ({ ...item }));
}

/**
 * Crea una instancia del Order_Service.
 *
 * @param store store en memoria; por defecto la instancia compartida del proceso. Las
 *   pruebas pueden inyectar una instancia aislada o una que simule fallos (Req. 5.6).
 * @param logger Logger para registrar la traza de la operación (Req. 7.1).
 */
export function createOrderService(
  store: MemoryStore = defaultStore,
  logger: Logger = defaultLogger,
): OrderService {
  function createOrderFromCart(cartId: string): Result<Order, OrderError> {
    // Req. 5.6 / 4.5: si el Cart no existe la creación no puede completarse; se retorna
    // ORDER_CREATION_FAILED sin crear ninguna Order ni construir una Preference.
    const found = store.getCart(cartId);
    if (!found.ok) {
      const error = orderCreationFailedError();
      logger.logFailure(OP_CREATE, found.error.message, cartId);
      return err(error);
    }

    const cart = found.value;

    // Req. 5.1 / 5.6: un Cart vacío es un error de validación; no se crea Order.
    if (cart.items.length === 0) {
      const error = orderCreationFailedError();
      logger.logFailure(OP_CREATE, 'El carrito no contiene ítems.', cartId);
      return err(error);
    }

    const amount = cart.total;

    // Req. 5.2: el monto debe ser un entero en [1, 999999999]. Un total fuera de rango
    // impide crear la Order (ORDER_CREATION_FAILED) sin construir una Preference.
    if (
      !Number.isInteger(amount) ||
      amount < MIN_ORDER_AMOUNT ||
      amount > MAX_ORDER_AMOUNT
    ) {
      const error = orderCreationFailedError();
      logger.logFailure(
        OP_CREATE,
        `El monto de la orden (${amount}) está fuera del rango permitido [${MIN_ORDER_AMOUNT}, ${MAX_ORDER_AMOUNT}].`,
        cartId,
      );
      return err(error);
    }

    const now = new Date().toISOString();
    const items = snapshotItems(cart.items);
    // Req. 5.1 / 5.2: Order "pending" con snapshot del carrito y amount entero CLP.
    const order: Order = {
      id: store.generateId(),
      cartSnapshot: {
        items,
        total: cart.total,
        currency: 'CLP',
      },
      amount,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };

    try {
      const saved = store.saveOrder(order);
      // Req. 7.1: la creación exitosa se registra vía Logger.
      logger.logSuccess(OP_CREATE, saved.id, {
        cartId,
        amount: saved.amount,
        status: saved.status,
      });
      return ok(saved);
    } catch (error) {
      // Req. 5.6: la creación falló; no se persiste ninguna Order parcial ni se
      // construye una Preference. Se registra el fallo y se retorna el error.
      const message = error instanceof Error ? error.message : String(error);
      logger.logFailure(OP_CREATE, message, cartId);
      return err(orderCreationFailedError());
    }
  }

  function getOrder(orderId: string): Result<Order, NotFoundError> {
    // Req. 4.5: una Order inexistente retorna NotFoundError sin alterar el estado.
    const found = store.getOrder(orderId);
    if (!found.ok) {
      logger.logFailure(OP_GET, found.error.message, orderId);
      return err(found.error);
    }
    return ok(found.value);
  }

  function applyPaymentResult(
    orderId: string,
    result: PaymentResult | string,
  ): Result<Order, OrderError | NotFoundError> {
    // Req. 6.4: una Order inexistente no modifica ningún estado; se registra la
    // incidencia y se retorna RESOURCE_NOT_FOUND.
    const found = store.getOrder(orderId);
    if (!found.ok) {
      logger.logFailure(
        OP_APPLY,
        `Notificación para Order inexistente: ${found.error.message}`,
        orderId,
        { result },
      );
      return err(found.error);
    }

    const order = found.value;

    // Req. 6.8: un resultado desconocido no modifica el estado; se registra la
    // incidencia como resultado de pago desconocido y se descarta (la Order se
    // devuelve sin cambios).
    if (!isKnownPaymentResult(result)) {
      logger.logFailure(OP_APPLY, 'Resultado de pago desconocido.', orderId, {
        code: UNKNOWN_PAYMENT_RESULT,
        result,
        currentStatus: order.status,
      });
      return ok(order);
    }

    const nextStatus = RESULT_TO_STATUS[result];

    // Req. 6.7: idempotencia. Si el estado destino coincide con el actual, la
    // notificación se descarta sin modificar la Order (no hay cambio real).
    if (nextStatus === order.status) {
      logger.logSuccess(OP_APPLY, orderId, {
        discarded: true,
        result,
        status: order.status,
      });
      return ok(order);
    }

    // Req. 6.1-6.3 / 6.5: cambio real de estado. Se persiste el nuevo estado con una
    // marca temporal actualizada y se registra la transición con el estado anterior y
    // el nuevo. La Order previa se conserva íntegra si la persistencia falla.
    const previousStatus = order.status;
    const now = new Date().toISOString();
    const updated: Order = {
      ...order,
      status: nextStatus,
      updatedAt: now,
    };

    try {
      const saved = store.saveOrder(updated);
      // Req. 6.5: registrar id, estado anterior, estado nuevo y marca temporal.
      logger.logSuccess(OP_APPLY, saved.id, {
        previousStatus,
        newStatus: saved.status,
        result,
        changedAt: now,
      });
      // Req. 7.3: además, registrar el evento de pago con el estado del pago.
      logger.logPaymentEvent(saved.id, STATUS_TO_PAYMENT_LOG[saved.status], 'exito', {
        previousStatus,
        newStatus: saved.status,
        changedAt: now,
      });
      return ok(saved);
    } catch (error) {
      // Atomicidad (design.md → Error Handling): ante un fallo interno no se persiste
      // ningún cambio parcial; el estado previo se conserva íntegro.
      const message = error instanceof Error ? error.message : String(error);
      logger.logFailure(OP_APPLY, message, orderId, { result, previousStatus });
      return err(orderCreationFailedError());
    }
  }

  return { createOrderFromCart, getOrder, applyPaymentResult };
}

/**
 * Instancia por defecto compartida por el proceso.
 * Los routers/consumidores la usan directamente; las pruebas pueden crear instancias
 * aisladas con `createOrderService(store, logger)`.
 */
export const orderService: OrderService = createOrderService();
