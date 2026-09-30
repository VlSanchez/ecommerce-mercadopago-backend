/**
 * Modelos del carrito de compras (Cart).
 *
 * Invariantes (design.md → Data Models / Cart):
 * - `quantity` siempre entero en [1, 99] cuando el ítem existe.
 * - `subtotal = unitPrice * quantity`.
 * - `total = Σ subtotal`. Con carrito vacío, `total = 0`.
 */
export interface CartItem {
  productId: string;
  /** entero, 1..99 */
  quantity: number;
  /** 2000 */
  unitPrice: number;
  /** unitPrice * quantity */
  subtotal: number;
}

export interface Cart {
  /** UUID único, no reutilizable durante la vida del proceso. */
  id: string;
  /** 0 o 1 ítem (producto único). */
  items: CartItem[];
  /** suma de subtotales, entero CLP. */
  total: number;
  currency: 'CLP';
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601 */
  updatedAt: string;
}
