import type { CartItem } from './cart.js';

/**
 * Estados posibles de una Order.
 * Referencia de diseño: design.md → Data Models / Order (máquina de estados).
 */
export type OrderStatus = 'pending' | 'paid' | 'rejected';

/**
 * Order — registro que representa una intención de compra y su estado de pago.
 *
 * Reglas de transición (design.md → Data Models / Order):
 * - inicia en "pending".
 * - "approved" → "paid", "rejected" → "rejected", "pending" → "pending".
 * - solo se aplica un cambio si el nuevo estado difiere del actual (idempotencia).
 */
export interface Order {
  /** UUID único, no reutilizable durante la vida del proceso. */
  id: string;
  /** Copia del carrito al momento de crear la orden. */
  cartSnapshot: {
    items: CartItem[];
    total: number;
    currency: 'CLP';
  };
  /** total en CLP, entero, 1..999999999. */
  amount: number;
  /** inicia en "pending". */
  status: OrderStatus;
  /** id de la Preference de MercadoPago (si se creó). */
  preferenceId?: string;
  /** init_point (solo si el pago se inició con éxito). */
  checkoutUrl?: string;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601 */
  updatedAt: string;
}
