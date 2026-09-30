import {
  ok,
  err,
  PRODUCT,
  cartLimitExceededError,
  cartUpdateFailedError,
  invalidQuantityError,
  type Cart,
  type CartItem,
  type CartError,
  type NotFoundError,
  type Result,
} from '../models/index.js';
import { memoryStore as defaultStore, type MemoryStore } from '../store/memoryStore.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';

/**
 * Cart_Service — crea y modifica el carrito de compras en memoria.
 *
 * Referencia de diseño: design.md → Components and Interfaces / Cart_Service y
 * Data Models / Cart. Cubre la tarea 5.1 (creación y adición) y la 5.2 (consulta,
 * ajuste de cantidad y eliminación del Product).
 *
 * Requerimientos:
 * - 2.1: al agregar el Product sin Cart previo, se crea un Cart con cantidad 1.
 * - 2.2: al agregar el Product ya presente, se incrementa la cantidad en 1 hasta 99.
 * - 2.3: si la cantidad resultante superaría 99, se rechaza la operación, se mantiene la
 *   cantidad previa sin cambios y se retorna `CART_LIMIT_EXCEEDED`.
 * - 2.4: el subtotal se calcula como `2000 * quantity`.
 * - 2.5: cada modificación se registra vía Logger con id de Cart, id de Product y
 *   la cantidad resultante (design.md → Property 16).
 * - 2.6: si la modificación no puede completarse, se conserva el estado previo íntegro
 *   y se retorna `CART_UPDATE_FAILED` (sin cambios parciales).
 * - 3.1: `getCart` retorna el Product, la cantidad y el total del Cart (consulta, no
 *   es modificación: no emite traza de modificación).
 * - 3.2: `setQuantity` fija la cantidad a un entero en `[1, 99]`.
 * - 3.3: cantidades inválidas (no entera, < 1, > 99) retornan `INVALID_QUANTITY` y
 *   conservan la cantidad anterior sin cambios.
 * - 3.4: `removeProduct` deja el Cart sin ítems con total 0 CLP.
 * - 3.5: el total se expresa como la suma de los subtotales, entero CLP.
 */

/** Cantidad mínima de unidades por Product en el Cart (Req. 3.2, 3.3). */
export const MIN_QUANTITY = 1;

/** Cantidad máxima de unidades por Product en el Cart (Req. 2.2, 2.3, 3.2, 3.3). */
export const MAX_QUANTITY = 99;

/** Nombres de operación usados en las entradas de log del Cart_Service (Req. 2.5). */
const OP_CREATE = 'cart.createCartWithProduct';
const OP_ADD = 'cart.addProduct';
const OP_SET_QUANTITY = 'cart.setQuantity';
const OP_REMOVE = 'cart.removeProduct';

/** Contrato público del Cart_Service (subconjunto implementado en la tarea 5.1). */
export interface CartService {
  /**
   * Crea un Cart nuevo con el Product único en cantidad 1 (Req. 2.1). Calcula el
   * subtotal y el total (Req. 2.4) y registra la operación (Req. 2.5). Si el store no
   * puede completar la operación, conserva el estado previo y retorna
   * `CART_UPDATE_FAILED` (Req. 2.6).
   */
  createCartWithProduct(): Result<Cart, CartError>;
  /**
   * Incrementa en 1 la cantidad del Product en el Cart indicado, hasta un máximo de 99
   * (Req. 2.2). Si el incremento superaría 99, rechaza la operación conservando la
   * cantidad previa y retorna `CART_LIMIT_EXCEEDED` (Req. 2.3). Si el Cart no existe,
   * retorna `RESOURCE_NOT_FOUND` sin alterar el estado (Req. 4.5). Si el store falla al
   * persistir, conserva el estado previo y retorna `CART_UPDATE_FAILED` (Req. 2.6).
   */
  addProduct(cartId: string): Result<Cart, CartError | NotFoundError>;
  /**
   * Retorna el Cart indicado con su Product, cantidad y total (Req. 3.1). Es una
   * consulta de solo lectura: no modifica el estado ni emite traza de modificación
   * (Property 16 aplica solo a modificaciones). Si el Cart no existe, retorna
   * `RESOURCE_NOT_FOUND` sin alterar el estado (Req. 4.5).
   */
  getCart(cartId: string): Result<Cart, NotFoundError>;
  /**
   * Fija la cantidad del Product a `qty` cuando es un entero en `[1, 99]` (Req. 3.2),
   * recalculando subtotal y total (Req. 3.5). Si `qty` no es entero, es menor que 1 o
   * mayor que 99, rechaza la operación conservando la cantidad anterior y retorna
   * `INVALID_QUANTITY` (Req. 3.3). Si el Cart no existe, retorna `RESOURCE_NOT_FOUND`
   * sin alterar el estado (Req. 4.5). Si el store falla al persistir, conserva el
   * estado previo y retorna `CART_UPDATE_FAILED` (Req. 2.6).
   */
  setQuantity(cartId: string, qty: number): Result<Cart, CartError | NotFoundError>;
  /**
   * Elimina el Product del Cart, dejándolo sin ítems y con total 0 CLP (Req. 3.4). Si
   * el Cart no existe, retorna `RESOURCE_NOT_FOUND` sin alterar el estado (Req. 4.5).
   * Si el store falla al persistir, conserva el estado previo y retorna
   * `CART_UPDATE_FAILED` (Req. 2.6).
   */
  removeProduct(cartId: string): Result<Cart, CartError | NotFoundError>;
}

/** Construye un `CartItem` con el subtotal derivado del precio del Product (Req. 2.4). */
function buildItem(quantity: number): CartItem {
  return {
    productId: PRODUCT.id,
    quantity,
    unitPrice: PRODUCT.price,
    // Req. 2.4: subtotal = 2000 * quantity (entero CLP).
    subtotal: PRODUCT.price * quantity,
  };
}

/** Suma de los subtotales de los ítems, entero CLP (Req. 2.4, invariante del total). */
function computeTotal(items: CartItem[]): number {
  return items.reduce((acc, item) => acc + item.subtotal, 0);
}

/**
 * Crea una instancia del Cart_Service.
 *
 * @param store store en memoria; por defecto la instancia compartida del proceso. Las
 *   pruebas pueden inyectar una instancia aislada o una que simule fallos (Req. 2.6).
 * @param logger Logger para registrar la traza de las modificaciones (Req. 2.5).
 */
export function createCartService(
  store: MemoryStore = defaultStore,
  logger: Logger = defaultLogger,
): CartService {
  function createCartWithProduct(): Result<Cart, CartError> {
    const now = new Date().toISOString();
    const items = [buildItem(1)];
    const cart: Cart = {
      id: store.generateId(),
      items,
      total: computeTotal(items),
      currency: 'CLP',
      createdAt: now,
      updatedAt: now,
    };

    try {
      const saved = store.saveCart(cart);
      // Req. 2.5 / Property 16: se registra id de Cart, id de Product y cantidad resultante.
      logger.logSuccess(OP_CREATE, saved.id, {
        productId: PRODUCT.id,
        quantity: saved.items[0]?.quantity ?? 0,
      });
      return ok(saved);
    } catch (error) {
      // Req. 2.6: el estado previo (Cart inexistente) se conserva; no hay cambios parciales.
      const message = error instanceof Error ? error.message : String(error);
      logger.logFailure(OP_CREATE, message, cart.id, { productId: PRODUCT.id });
      return err(cartUpdateFailedError());
    }
  }

  function addProduct(cartId: string): Result<Cart, CartError | NotFoundError> {
    // Req. 4.5: un Cart inexistente retorna NotFoundError sin alterar el estado.
    const found = store.getCart(cartId);
    if (!found.ok) {
      logger.logFailure(OP_ADD, found.error.message, cartId);
      return err(found.error);
    }

    const current = found.value;
    const currentItem = current.items[0];
    const currentQuantity = currentItem?.quantity ?? 0;
    const nextQuantity = currentQuantity + 1;

    // Req. 2.3: si la cantidad resultante superaría 99, se rechaza conservando la
    // cantidad previa sin cambios (no se persiste ninguna modificación).
    if (nextQuantity > MAX_QUANTITY) {
      const error = cartLimitExceededError();
      logger.logFailure(OP_ADD, error.message, cartId, {
        productId: PRODUCT.id,
        quantity: currentQuantity,
      });
      return err(error);
    }

    // Req. 2.2 / 2.4: se incrementa la cantidad y se recalculan subtotal y total.
    const items = [buildItem(nextQuantity)];
    const updated: Cart = {
      ...current,
      items,
      total: computeTotal(items),
      updatedAt: new Date().toISOString(),
    };

    try {
      const saved = store.saveCart(updated);
      // Req. 2.5 / Property 16: id de Cart, id de Product y cantidad resultante.
      logger.logSuccess(OP_ADD, saved.id, {
        productId: PRODUCT.id,
        quantity: saved.items[0]?.quantity ?? 0,
      });
      return ok(saved);
    } catch (error) {
      // Req. 2.6: no se persiste ningún cambio parcial; el estado previo del Cart
      // permanece íntegro en el store porque `updated` es un objeto nuevo.
      const message = error instanceof Error ? error.message : String(error);
      logger.logFailure(OP_ADD, message, cartId, {
        productId: PRODUCT.id,
        quantity: currentQuantity,
      });
      return err(cartUpdateFailedError());
    }
  }

  function getCart(cartId: string): Result<Cart, NotFoundError> {
    // Req. 3.1 / 4.5: consulta de solo lectura. Un Cart inexistente retorna
    // NotFoundError sin alterar el estado; no se emite traza de modificación
    // (Property 16 solo cubre modificaciones).
    const found = store.getCart(cartId);
    if (!found.ok) {
      return err(found.error);
    }
    return ok(found.value);
  }

  function setQuantity(
    cartId: string,
    qty: number,
  ): Result<Cart, CartError | NotFoundError> {
    // Req. 4.5: un Cart inexistente retorna NotFoundError sin alterar el estado.
    const found = store.getCart(cartId);
    if (!found.ok) {
      logger.logFailure(OP_SET_QUANTITY, found.error.message, cartId);
      return err(found.error);
    }

    const current = found.value;
    const currentQuantity = current.items[0]?.quantity ?? 0;

    // Req. 3.3: cantidad inválida (no entera, < 1 o > 99) se rechaza conservando la
    // cantidad anterior sin cambios (no se persiste ninguna modificación).
    if (!Number.isInteger(qty) || qty < MIN_QUANTITY || qty > MAX_QUANTITY) {
      const error = invalidQuantityError();
      logger.logFailure(OP_SET_QUANTITY, error.message, cartId, {
        productId: PRODUCT.id,
        quantity: currentQuantity,
      });
      return err(error);
    }

    // Req. 3.2 / 3.5: se fija la cantidad exacta y se recalculan subtotal y total.
    const items = [buildItem(qty)];
    const updated: Cart = {
      ...current,
      items,
      total: computeTotal(items),
      updatedAt: new Date().toISOString(),
    };

    try {
      const saved = store.saveCart(updated);
      // Req. 2.5 / Property 16: id de Cart, id de Product y cantidad resultante.
      logger.logSuccess(OP_SET_QUANTITY, saved.id, {
        productId: PRODUCT.id,
        quantity: saved.items[0]?.quantity ?? 0,
      });
      return ok(saved);
    } catch (error) {
      // Req. 2.6: no se persiste ningún cambio parcial; el estado previo del Cart
      // permanece íntegro en el store porque `updated` es un objeto nuevo.
      const message = error instanceof Error ? error.message : String(error);
      logger.logFailure(OP_SET_QUANTITY, message, cartId, {
        productId: PRODUCT.id,
        quantity: currentQuantity,
      });
      return err(cartUpdateFailedError());
    }
  }

  function removeProduct(cartId: string): Result<Cart, CartError | NotFoundError> {
    // Req. 4.5: un Cart inexistente retorna NotFoundError sin alterar el estado.
    const found = store.getCart(cartId);
    if (!found.ok) {
      logger.logFailure(OP_REMOVE, found.error.message, cartId);
      return err(found.error);
    }

    const current = found.value;

    // Req. 3.4 / 3.5: el Cart queda sin ítems y con total 0 CLP (suma vacía de subtotales).
    const items: CartItem[] = [];
    const updated: Cart = {
      ...current,
      items,
      total: computeTotal(items),
      updatedAt: new Date().toISOString(),
    };

    try {
      const saved = store.saveCart(updated);
      // Req. 2.5 / Property 16: id de Cart, id de Product y cantidad resultante (0).
      logger.logSuccess(OP_REMOVE, saved.id, {
        productId: PRODUCT.id,
        quantity: saved.items[0]?.quantity ?? 0,
      });
      return ok(saved);
    } catch (error) {
      // Req. 2.6: no se persiste ningún cambio parcial; el estado previo del Cart
      // permanece íntegro en el store porque `updated` es un objeto nuevo.
      const message = error instanceof Error ? error.message : String(error);
      logger.logFailure(OP_REMOVE, message, cartId, { productId: PRODUCT.id });
      return err(cartUpdateFailedError());
    }
  }

  return { createCartWithProduct, addProduct, getCart, setQuantity, removeProduct };
}

/**
 * Instancia por defecto compartida por el proceso.
 * Los routers/consumidores la usan directamente; las pruebas pueden crear instancias
 * aisladas con `createCartService(store, logger)`.
 */
export const cartService: CartService = createCartService();
