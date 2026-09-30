/**
 * Errores de dominio compartidos.
 *
 * `NotFoundError` es el error retornado al solicitar un Cart u Order cuyo id no existe
 * en memoria (Req. 4.5). Su código `RESOURCE_NOT_FOUND` mapea a HTTP 404 según
 * design.md → Error Handling.
 */
export interface NotFoundError {
  code: 'RESOURCE_NOT_FOUND';
  message: string;
  /** identificador solicitado que no existe en memoria. */
  id: string;
  /** tipo de recurso buscado. */
  resource: 'cart' | 'order';
}

/** Construye un NotFoundError para un recurso ausente. */
export function notFoundError(resource: 'cart' | 'order', id: string): NotFoundError {
  return {
    code: 'RESOURCE_NOT_FOUND',
    message: `No se encontró el recurso ${resource} con id "${id}".`,
    id,
    resource,
  };
}

/**
 * `CatalogError` es el error retornado por el Catalog_Service cuando el Product no está
 * disponible (Req. 1.5). Su código `PRODUCT_UNAVAILABLE` mapea a HTTP 404/503 según
 * design.md → Error Handling.
 */
export interface CatalogError {
  code: 'PRODUCT_UNAVAILABLE';
  message: string;
}

/** Construye un CatalogError indicando que el producto no está disponible (Req. 1.5). */
export function productUnavailableError(): CatalogError {
  return {
    code: 'PRODUCT_UNAVAILABLE',
    message: 'El producto no está disponible.',
  };
}

/**
 * `CartError` agrupa los errores de negocio esperados del Cart_Service.
 *
 * Códigos (design.md → Error Handling / Mapeo de errores a HTTP):
 * - `CART_LIMIT_EXCEEDED` (Req. 2.3): la cantidad resultante superaría 99 unidades;
 *   mapea a HTTP 409.
 * - `CART_UPDATE_FAILED` (Req. 2.6): la modificación del Cart no pudo completarse; el
 *   estado previo se conserva íntegro; mapea a HTTP 500.
 * - `INVALID_QUANTITY` (Req. 3.3): cantidad fuera de `[1, 99]` o no entera; el estado
 *   previo se conserva; mapea a HTTP 400.
 */
export interface CartError {
  code: 'CART_LIMIT_EXCEEDED' | 'CART_UPDATE_FAILED' | 'INVALID_QUANTITY';
  message: string;
}

/**
 * Construye un `CART_LIMIT_EXCEEDED` indicando que se alcanzó el límite máximo de
 * unidades por producto (Req. 2.3).
 */
export function cartLimitExceededError(): CartError {
  return {
    code: 'CART_LIMIT_EXCEEDED',
    message: 'Se alcanzó el límite máximo de unidades por producto.',
  };
}

/**
 * Construye un `CART_UPDATE_FAILED` indicando que la modificación del carrito no se
 * completó (Req. 2.6). El estado previo del Cart se mantiene sin cambios.
 */
export function cartUpdateFailedError(): CartError {
  return {
    code: 'CART_UPDATE_FAILED',
    message: 'No se pudo completar la modificación del carrito.',
  };
}

/**
 * Construye un `INVALID_QUANTITY` indicando que la cantidad solicitada es inválida
 * (fuera de `[1, 99]` o no entera) (Req. 3.3). La cantidad anterior se conserva.
 */
export function invalidQuantityError(): CartError {
  return {
    code: 'INVALID_QUANTITY',
    message: 'La cantidad debe ser un entero entre 1 y 99.',
  };
}

/**
 * `OrderError` agrupa los errores de negocio esperados del Order_Service.
 *
 * Códigos (design.md → Error Handling / Mapeo de errores a HTTP):
 * - `ORDER_CREATION_FAILED` (Req. 5.6): la creación de la Order no pudo completarse; no
 *   se construye una Preference de MercadoPago; mapea a HTTP 500.
 */
export interface OrderError {
  code: 'ORDER_CREATION_FAILED';
  message: string;
}

/**
 * Construye un `ORDER_CREATION_FAILED` indicando que la orden no pudo generarse
 * (Req. 5.6). No se construye una Preference de MercadoPago.
 */
export function orderCreationFailedError(): OrderError {
  return {
    code: 'ORDER_CREATION_FAILED',
    message: 'No se pudo generar la orden.',
  };
}

/**
 * `PaymentError` agrupa los errores de negocio esperados del Payment_Service.
 *
 * Códigos (design.md → Error Handling / Mapeo de errores a HTTP):
 * - `EMPTY_CART` (Req. 5.4): el carrito está vacío o no existe; no se crea ninguna
 *   Order ni se construye una Preference; mapea a HTTP 400.
 * - `ORDER_CREATION_FAILED` (Req. 5.6): la creación de la Order no pudo completarse; no
 *   se construye una Preference de MercadoPago; mapea a HTTP 500.
 * - `PAYMENT_INIT_FAILED` (Req. 5.5): MercadoPago falló o excedió los 30s al crear la
 *   Preference; la Order permanece en "pending" sin `checkoutUrl`; mapea a HTTP 502.
 * - `INVALID_SIGNATURE` (Req. 6.6): la firma de la notificación del webhook es inválida;
 *   no se modifica ninguna Order; mapea a HTTP 401.
 * - `ORDER_REF_NOT_FOUND` (Req. 6.4): la notificación referencia una Order inexistente;
 *   mapea a HTTP 404.
 */
export interface PaymentError {
  code:
    | 'EMPTY_CART'
    | 'ORDER_CREATION_FAILED'
    | 'PAYMENT_INIT_FAILED'
    | 'INVALID_SIGNATURE'
    | 'ORDER_REF_NOT_FOUND';
  message: string;
}

/**
 * Construye un `EMPTY_CART` indicando que el carrito está vacío o no existe (Req. 5.4).
 * No se crea ninguna Order ni se construye una Preference de MercadoPago.
 */
export function emptyCartError(): PaymentError {
  return {
    code: 'EMPTY_CART',
    message: 'El carrito está vacío o no existe.',
  };
}

/**
 * Construye un `PAYMENT_INIT_FAILED` indicando que no se pudo iniciar el pago con
 * MercadoPago por error o timeout al crear la Preference (Req. 5.5). La Order permanece
 * en "pending" sin `checkoutUrl`.
 */
export function paymentInitFailedError(): PaymentError {
  return {
    code: 'PAYMENT_INIT_FAILED',
    message: 'No se pudo iniciar el pago con MercadoPago.',
  };
}

/**
 * Construye un `PaymentError` con código `ORDER_CREATION_FAILED` para reflejar en el
 * Payment_Service el fallo de creación de la Order propagado por el Order_Service
 * (Req. 5.6).
 */
export function paymentOrderCreationFailedError(): PaymentError {
  return {
    code: 'ORDER_CREATION_FAILED',
    message: 'No se pudo generar la orden.',
  };
}

/**
 * Construye un `INVALID_SIGNATURE` indicando que la firma de la notificación del webhook
 * no pudo validarse como proveniente de MercadoPago (Req. 6.6). No se modifica ninguna
 * Order.
 */
export function invalidSignatureError(): PaymentError {
  return {
    code: 'INVALID_SIGNATURE',
    message: 'La notificación no pudo ser autenticada.',
  };
}

/**
 * Construye un `ORDER_REF_NOT_FOUND` indicando que la notificación referencia una Order
 * inexistente (Req. 6.4). No se modifica ningún estado.
 */
export function orderRefNotFoundError(): PaymentError {
  return {
    code: 'ORDER_REF_NOT_FOUND',
    message: 'La Order referenciada por la notificación no existe.',
  };
}
