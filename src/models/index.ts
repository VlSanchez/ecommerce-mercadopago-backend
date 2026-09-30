/**
 * Punto de entrada de las interfaces de dominio.
 * Reexporta los tipos y constantes base usados por los servicios.
 */
export type { Result } from './result.js';
export { ok, err } from './result.js';
export type { Product } from './product.js';
export { PRODUCT } from './product.js';
export type { CartItem, Cart } from './cart.js';
export type { OrderStatus, Order } from './order.js';
export type {
  PreferenceRequest,
  PreferenceRequestItem,
} from './preference.js';
export type {
  NotFoundError,
  CatalogError,
  CartError,
  OrderError,
  PaymentError,
} from './errors.js';
export {
  notFoundError,
  productUnavailableError,
  cartLimitExceededError,
  cartUpdateFailedError,
  invalidQuantityError,
  orderCreationFailedError,
  emptyCartError,
  paymentInitFailedError,
  paymentOrderCreationFailedError,
  invalidSignatureError,
  orderRefNotFoundError,
} from './errors.js';
