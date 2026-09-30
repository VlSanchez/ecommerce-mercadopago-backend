import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createMemoryStore } from './memoryStore.js';
import { PRODUCT } from '../models/index.js';
import type { Order, OrderStatus } from '../models/index.js';

/**
 * Property-based test (fast-check) del round-trip del estado en memoria.
 *
 * Cubre la Correctness Property 8 (design.md → Correctness Properties): para cualquier Order
 * válida guardada en el store, consultarla por su `id` devuelve la MISMA Order mientras el
 * proceso vive (round-trip save/get).
 *
 * Se usa `createMemoryStore()` para instancias aisladas por caso (evita contaminación entre
 * ejecuciones). No hay cobertura property-based previa de este round-trip para orders.
 * Cada test corre >=100 casos (`{ numRuns: 100 }`).
 */

/** Generador de una Order válida con un ítem (cantidad/precio/id variados). */
const orderArb: fc.Arbitrary<Order> = fc
  .record({
    id: fc.uuid(),
    quantity: fc.integer({ min: 1, max: 99 }),
    unitPrice: fc.integer({ min: 1, max: 999_999 }),
    status: fc.constantFrom<OrderStatus>('pending', 'paid', 'rejected'),
  })
  .map(({ id, quantity, unitPrice, status }): Order => {
    const subtotal = unitPrice * quantity;
    const now = '2024-01-01T00:00:00.000Z';
    return {
      id,
      cartSnapshot: {
        items: [{ productId: PRODUCT.id, quantity, unitPrice, subtotal }],
        total: subtotal,
        currency: 'CLP',
      },
      amount: subtotal,
      status,
      createdAt: now,
      updatedAt: now,
    };
  });

// ---------------------------------------------------------------------------
// Feature: production-deployment-certification, Property 8
// P8: El estado en memoria se conserva mientras el proceso vive — Validates: Requirements 10.2
// ---------------------------------------------------------------------------
describe('Property 8 — round-trip del estado en memoria (orders)', () => {
  // Feature: production-deployment-certification, Property 8
  it('para cualquier Order válida guardada, getOrder(id) devuelve la misma Order', () => {
    fc.assert(
      fc.property(orderArb, (order) => {
        const store = createMemoryStore();
        store.saveOrder(order);

        const result = store.getOrder(order.id);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // Debe devolver exactamente la misma Order (misma referencia y mismo contenido).
        expect(result.value).toBe(order);
        expect(result.value).toEqual(order);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: production-deployment-certification, Property 8
  it('el round-trip se preserva con múltiples Orders de ids distintos guardadas en el mismo store', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(orderArb, {
          minLength: 1,
          maxLength: 10,
          selector: (o) => o.id,
        }),
        (orders) => {
          const store = createMemoryStore();
          for (const order of orders) {
            store.saveOrder(order);
          }
          // Cada Order guardada se recupera igual por su id.
          for (const order of orders) {
            const result = store.getOrder(order.id);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value).toEqual(order);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
