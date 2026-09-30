import { v4 as uuidv4 } from 'uuid';
import { ok, err, notFoundError, type Result, type NotFoundError } from '../models/index.js';
import type { Cart } from '../models/cart.js';
import type { Order } from '../models/order.js';

export type { NotFoundError } from '../models/errors.js';

/**
 * In-Memory Store — encapsula los `Map` de carts y orders y la generación de
 * identificadores únicos no reutilizables durante la vida del proceso.
 *
 * Referencia de diseño: design.md → Data Models / In-Memory Store.
 * Requerimientos: 4.1 (round-trip), 4.2 (estado inicial vacío), 4.3/4.4 (unicidad),
 * 4.5 (recurso inexistente retorna NotFoundError sin alterar el estado).
 */

/**
 * Contrato del store en memoria.
 * Cada método de consulta retorna `Result` para evitar excepciones en flujos esperados.
 */
export interface MemoryStore {
  /** Genera un identificador UUID v4 único no reutilizado durante la vida del proceso. */
  generateId(): string;
  /** Guarda (crea o reemplaza) un Cart bajo su id. */
  saveCart(cart: Cart): Cart;
  /** Recupera un Cart por id; NotFoundError si no existe (sin alterar el estado). */
  getCart(id: string): Result<Cart, NotFoundError>;
  /** Guarda (crea o reemplaza) una Order bajo su id. */
  saveOrder(order: Order): Order;
  /** Recupera una Order por id; NotFoundError si no existe (sin alterar el estado). */
  getOrder(id: string): Result<Order, NotFoundError>;
  /** Cantidad de carts almacenados (para verificación de estado inicial vacío). */
  cartCount(): number;
  /** Cantidad de orders almacenadas (para verificación de estado inicial vacío). */
  orderCount(): number;
}

/**
 * Crea una instancia aislada del store en memoria.
 *
 * Cada instancia arranca con 0 carts y 0 orders (Req. 4.2) y mantiene un registro
 * de todos los ids emitidos para garantizar que nunca se reutilicen (Req. 4.3, 4.4).
 */
export function createMemoryStore(): MemoryStore {
  const carts = new Map<string, Cart>();
  const orders = new Map<string, Order>();
  /** Ids ya emitidos: garantiza no reutilización aun tras eliminar registros. */
  const issuedIds = new Set<string>();

  function generateId(): string {
    let id = uuidv4();
    // UUID v4 tiene colisión prácticamente nula, pero re-generamos ante cualquier
    // repetición para asegurar formalmente la unicidad (Req. 4.3, 4.4).
    while (issuedIds.has(id)) {
      id = uuidv4();
    }
    issuedIds.add(id);
    return id;
  }

  function saveCart(cart: Cart): Cart {
    carts.set(cart.id, cart);
    return cart;
  }

  function getCart(id: string): Result<Cart, NotFoundError> {
    const cart = carts.get(id);
    if (cart === undefined) {
      // No se crea ni modifica ningún registro (Req. 4.5).
      return err(notFoundError('cart', id));
    }
    return ok(cart);
  }

  function saveOrder(order: Order): Order {
    orders.set(order.id, order);
    return order;
  }

  function getOrder(id: string): Result<Order, NotFoundError> {
    const order = orders.get(id);
    if (order === undefined) {
      // No se crea ni modifica ningún registro (Req. 4.5).
      return err(notFoundError('order', id));
    }
    return ok(order);
  }

  function cartCount(): number {
    return carts.size;
  }

  function orderCount(): number {
    return orders.size;
  }

  return {
    generateId,
    saveCart,
    getCart,
    saveOrder,
    getOrder,
    cartCount,
    orderCount,
  };
}

/**
 * Instancia por defecto compartida por el proceso.
 * Los servicios de dominio la consumen; las pruebas pueden crear instancias aisladas
 * mediante `createMemoryStore()`.
 */
export const memoryStore: MemoryStore = createMemoryStore();
