import { describe, it, expect } from 'vitest';
import { PRODUCT } from '../models/index.js';
import type { Cart } from '../models/index.js';
import { createMemoryStore, type MemoryStore } from '../store/memoryStore.js';
import { createLogger, type Logger } from '../lib/logger.js';
import { createCartService } from './cartService.js';
import { createOrderService } from './orderService.js';

/**
 * Pruebas unitarias del Order_Service (tarea 7.1: creación y consulta de órdenes).
 * Cubren ejemplos y casos borde de los Req. 5.1, 5.2, 5.6 y 4.5.
 */

/** Logger silencioso para no ensuciar la salida de las pruebas. */
function silentLogger(): Logger {
  return createLogger(() => {});
}

/** Crea un Cart con `quantity` unidades del Product único y lo guarda en el store. */
function seedCart(store: MemoryStore, quantity: number): Cart {
  const cart = createCartService(store, silentLogger());
  const created = cart.createCartWithProduct();
  if (!created.ok) throw new Error('no se pudo crear el carrito de prueba');
  if (quantity !== 1) {
    const set = cart.setQuantity(created.value.id, quantity);
    if (!set.ok) throw new Error('no se pudo fijar la cantidad de prueba');
    return set.value;
  }
  return created.value;
}

describe('orderService.createOrderFromCart', () => {
  it('crea una Order "pending" con snapshot y amount desde un carrito no vacío (Req. 5.1, 5.2)', () => {
    const store = createMemoryStore();
    const seeded = seedCart(store, 3);
    const orders = createOrderService(store, silentLogger());

    const result = orders.createOrderFromCart(seeded.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const order = result.value;
    expect(order.status).toBe('pending');
    expect(order.amount).toBe(PRODUCT.price * 3);
    expect(order.cartSnapshot.total).toBe(seeded.total);
    expect(order.cartSnapshot.currency).toBe('CLP');
    expect(order.cartSnapshot.items).toEqual(seeded.items);
    expect(order.amount).toBeGreaterThanOrEqual(1);
    expect(order.amount).toBeLessThanOrEqual(999999999);
    expect(order.preferenceId).toBeUndefined();
    expect(order.checkoutUrl).toBeUndefined();
    // La Order queda almacenada y recuperable.
    expect(store.orderCount()).toBe(1);
  });

  it('el snapshot es una copia independiente del carrito original', () => {
    const store = createMemoryStore();
    const seeded = seedCart(store, 2);
    const orders = createOrderService(store, silentLogger());

    const result = orders.createOrderFromCart(seeded.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Mutar el snapshot no debe afectar los ítems del carrito original.
    result.value.cartSnapshot.items[0]!.quantity = 99;
    expect(seeded.items[0]!.quantity).toBe(2);
  });

  it('retorna ORDER_CREATION_FAILED sin crear Order si el carrito no existe (Req. 5.6)', () => {
    const store = createMemoryStore();
    const orders = createOrderService(store, silentLogger());

    const result = orders.createOrderFromCart('inexistente');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ORDER_CREATION_FAILED');
    expect(store.orderCount()).toBe(0);
  });

  it('retorna ORDER_CREATION_FAILED sin crear Order si el carrito está vacío (Req. 5.1, 5.6)', () => {
    const store = createMemoryStore();
    const seeded = seedCart(store, 1);
    // Vaciar el carrito.
    const cart = createCartService(store, silentLogger());
    const removed = cart.removeProduct(seeded.id);
    expect(removed.ok).toBe(true);

    const orders = createOrderService(store, silentLogger());
    const result = orders.createOrderFromCart(seeded.id);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ORDER_CREATION_FAILED');
    expect(store.orderCount()).toBe(0);
  });

  it('retorna ORDER_CREATION_FAILED sin construir Preference si el store falla al persistir (Req. 5.6)', () => {
    const store = createMemoryStore();
    const seeded = seedCart(store, 1);
    // Simular un fallo del store al persistir la Order.
    const failingStore: MemoryStore = {
      ...store,
      saveOrder() {
        throw new Error('fallo simulado del store');
      },
    };
    const orders = createOrderService(failingStore, silentLogger());

    const result = orders.createOrderFromCart(seeded.id);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ORDER_CREATION_FAILED');
    expect(store.orderCount()).toBe(0);
  });
});

describe('orderService.getOrder', () => {
  it('retorna la Order existente (Req. 4.5)', () => {
    const store = createMemoryStore();
    const seeded = seedCart(store, 1);
    const orders = createOrderService(store, silentLogger());
    const created = orders.createOrderFromCart(seeded.id);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = orders.getOrder(created.value.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(created.value);
  });

  it('retorna RESOURCE_NOT_FOUND para una Order inexistente (Req. 4.5)', () => {
    const store = createMemoryStore();
    const orders = createOrderService(store, silentLogger());

    const result = orders.getOrder('inexistente');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('RESOURCE_NOT_FOUND');
    expect(result.error.resource).toBe('order');
  });
});

describe('orderService.applyPaymentResult', () => {
  /** Crea un store con una Order "pending" recién creada y devuelve store + orderId. */
  function seedOrder(): { store: MemoryStore; orderId: string } {
    const store = createMemoryStore();
    const seeded = seedCart(store, 1);
    const orders = createOrderService(store, silentLogger());
    const created = orders.createOrderFromCart(seeded.id);
    if (!created.ok) throw new Error('no se pudo crear la orden de prueba');
    return { store, orderId: created.value.id };
  }

  it('mapea "approved" → "paid" desde una Order pending (Req. 6.1)', () => {
    const { store, orderId } = seedOrder();
    const orders = createOrderService(store, silentLogger());

    const result = orders.applyPaymentResult(orderId, 'approved');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('paid');
    // El cambio quedó persistido.
    const reloaded = orders.getOrder(orderId);
    expect(reloaded.ok && reloaded.value.status).toBe('paid');
  });

  it('mapea "rejected" → "rejected" desde una Order pending (Req. 6.2)', () => {
    const { store, orderId } = seedOrder();
    const orders = createOrderService(store, silentLogger());

    const result = orders.applyPaymentResult(orderId, 'rejected');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('rejected');
  });

  it('mapea "pending" → "pending" sin cambio real de estado (Req. 6.3)', () => {
    const { store, orderId } = seedOrder();
    const orders = createOrderService(store, silentLogger());
    const before = orders.getOrder(orderId);
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const result = orders.applyPaymentResult(orderId, 'pending');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('pending');
    // Sin cambio real: no se toca updatedAt (se descarta como idempotente).
    expect(result.value.updatedAt).toBe(before.value.updatedAt);
  });

  it('es idempotente: aplicar "approved" dos veces deja el mismo estado que una vez (Req. 6.7)', () => {
    const { store, orderId } = seedOrder();
    const orders = createOrderService(store, silentLogger());

    const first = orders.applyPaymentResult(orderId, 'approved');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = orders.applyPaymentResult(orderId, 'approved');
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.value.status).toBe('paid');
    // La notificación repetida se descartó sin modificar la Order (mismo updatedAt).
    expect(second.value.updatedAt).toBe(first.value.updatedAt);
    expect(second.value).toEqual(first.value);
  });

  it('descarta una notificación que coincide con el estado final actual sin modificar la Order (Req. 6.7)', () => {
    const { store, orderId } = seedOrder();
    const orders = createOrderService(store, silentLogger());
    // Llevar a "rejected" (estado final).
    const applied = orders.applyPaymentResult(orderId, 'rejected');
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const finalOrder = applied.value;

    // Notificación "rejected" repetida: se descarta.
    const again = orders.applyPaymentResult(orderId, 'rejected');
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value).toEqual(finalOrder);
  });

  it('ignora un resultado desconocido sin modificar el estado y registra la incidencia (Req. 6.8)', () => {
    const { store, orderId } = seedOrder();
    const entries: string[] = [];
    const capturingLogger = createLogger((entry) => {
      entries.push(JSON.stringify(entry));
    });
    const orders = createOrderService(store, capturingLogger);
    const before = orders.getOrder(orderId);
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const result = orders.applyPaymentResult(orderId, 'refunded');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Estado sin cambios.
    expect(result.value.status).toBe('pending');
    expect(result.value.updatedAt).toBe(before.value.updatedAt);
    // Se registró la incidencia como resultado de pago desconocido.
    expect(entries.some((e) => e.includes('UNKNOWN_PAYMENT_RESULT'))).toBe(true);
  });

  it('retorna RESOURCE_NOT_FOUND para una Order inexistente sin modificar el estado (Req. 6.4)', () => {
    const store = createMemoryStore();
    const orders = createOrderService(store, silentLogger());

    const result = orders.applyPaymentResult('inexistente', 'approved');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('RESOURCE_NOT_FOUND');
    // No se creó ni modificó ninguna Order.
    expect(store.orderCount()).toBe(0);
  });

  it('registra el cambio real con id, estado anterior, estado nuevo y marca temporal (Req. 6.5)', () => {
    const { store, orderId } = seedOrder();
    const captured: Record<string, unknown>[] = [];
    const capturingLogger = createLogger((entry) => {
      if (entry.operation === 'order.applyPaymentResult' && entry.outcome === 'exito') {
        captured.push(entry.details ?? {});
      }
    });
    const orders = createOrderService(store, capturingLogger);

    orders.applyPaymentResult(orderId, 'approved');

    const changeEntry = captured.find((d) => d.newStatus !== undefined);
    expect(changeEntry).toBeDefined();
    expect(changeEntry!.previousStatus).toBe('pending');
    expect(changeEntry!.newStatus).toBe('paid');
    expect(typeof changeEntry!.changedAt).toBe('string');
  });

  it('conserva el estado previo si el store falla al persistir el cambio', () => {
    const { store, orderId } = seedOrder();
    const failingStore: MemoryStore = {
      ...store,
      saveOrder() {
        throw new Error('fallo simulado del store');
      },
    };
    const orders = createOrderService(failingStore, silentLogger());

    const result = orders.applyPaymentResult(orderId, 'approved');

    expect(result.ok).toBe(false);
    // La Order original conserva su estado "pending".
    const reloaded = createOrderService(store, silentLogger()).getOrder(orderId);
    expect(reloaded.ok && reloaded.value.status).toBe('pending');
  });
});
