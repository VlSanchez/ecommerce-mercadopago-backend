import { Router, type Request, type Response } from 'express';
import { cartService as defaultCartService, type CartService } from '../services/cartService.js';
import type { CartError, NotFoundError } from '../models/index.js';

/**
 * Cart Router — expone los endpoints REST del carrito de compras y delega en el
 * Cart_Service, traduciendo cada `Result` de error a su código HTTP y a un cuerpo JSON
 * consistente (design.md → Error Handling / Mapeo de errores a HTTP).
 *
 * Referencia de diseño: design.md → Backend (server.js / app.js) y Error Handling.
 *
 * Endpoints:
 * - `POST   /api/cart`                → crea un Cart con el Product en cantidad 1 (Req. 2.1) → 201.
 * - `GET    /api/cart/:cartId`        → consulta el Cart (Product, cantidad y total) (Req. 3.1) → 200.
 * - `POST   /api/cart/:cartId/items`  → incrementa la cantidad en 1, hasta 99 (Req. 2.2, 2.3) → 200.
 * - `PATCH  /api/cart/:cartId/items`  → fija la cantidad en `[1, 99]` (Req. 3.2, 3.3) → 200.
 * - `DELETE /api/cart/:cartId/items`  → vacía el Cart, total 0 CLP (Req. 3.4) → 200.
 *
 * Mapeo de errores a HTTP:
 * - `RESOURCE_NOT_FOUND`   → 404 (Cart inexistente, Req. 4.5).
 * - `CART_LIMIT_EXCEEDED`  → 409 (límite de 99 unidades excedido, Req. 2.3).
 * - `INVALID_QUANTITY`     → 400 (cantidad fuera de rango o no entera, Req. 3.3).
 * - `CART_UPDATE_FAILED`   → 500 (modificación no completada, Req. 2.6).
 */

/** Unión de códigos de error que puede retornar el Cart_Service a este router. */
type CartRouterError = CartError | NotFoundError;

/** Cuerpo de error JSON consistente (design.md → Error Handling). */
interface ErrorBody {
  error: { code: string; message: string };
}

/**
 * Mapea el `code` de un error de dominio a su código HTTP correspondiente
 * (design.md → Mapeo de errores a HTTP). Cualquier código no contemplado degrada a 500.
 */
function statusForError(error: CartRouterError): number {
  switch (error.code) {
    case 'RESOURCE_NOT_FOUND':
      return 404;
    case 'CART_LIMIT_EXCEEDED':
      return 409;
    case 'INVALID_QUANTITY':
      return 400;
    case 'CART_UPDATE_FAILED':
      return 500;
    default:
      return 500;
  }
}

/** Construye el cuerpo JSON de error a partir de un error de dominio. */
function errorBody(error: CartRouterError): ErrorBody {
  return { error: { code: error.code, message: error.message } };
}

/** Responde con el error de dominio usando su HTTP y cuerpo consistentes. */
function sendError(res: Response, error: CartRouterError): void {
  res.status(statusForError(error)).json(errorBody(error));
}

/**
 * Crea un Router de Express para el carrito, delegando en el Cart_Service inyectado.
 *
 * @param service instancia del Cart_Service; por defecto la compartida del proceso. Las
 *   pruebas pueden inyectar una instancia aislada con `createCartRouter(cartServiceMock)`.
 */
export function createCartRouter(service: CartService = defaultCartService): Router {
  const router = Router();

  // Req. 2.1: crea un Cart nuevo con el Product en cantidad 1 → 201.
  router.post('/', (_req: Request, res: Response) => {
    const result = service.createCartWithProduct();
    if (!result.ok) {
      sendError(res, result.error);
      return;
    }
    res.status(201).json(result.value);
  });

  // Req. 3.1 / 4.5: consulta el Cart; Cart inexistente → 404.
  router.get('/:cartId', (req: Request, res: Response) => {
    const cartId = req.params.cartId as string;
    const result = service.getCart(cartId);
    if (!result.ok) {
      sendError(res, result.error);
      return;
    }
    res.status(200).json(result.value);
  });

  // Req. 2.2 / 2.3 / 4.5: incrementa la cantidad en 1 hasta 99; límite → 409, Cart inexistente → 404.
  router.post('/:cartId/items', (req: Request, res: Response) => {
    const cartId = req.params.cartId as string;
    const result = service.addProduct(cartId);
    if (!result.ok) {
      sendError(res, result.error);
      return;
    }
    res.status(200).json(result.value);
  });

  // Req. 3.2 / 3.3 / 4.5: fija la cantidad; la validación de `[1, 99]`/entero la realiza
  // el servicio (INVALID_QUANTITY → 400). Se delega el `quantity` crudo del body (incluido
  // `undefined` cuando falta) para que el servicio decida.
  router.patch('/:cartId/items', (req: Request, res: Response) => {
    const cartId = req.params.cartId as string;
    const quantity = (req.body ?? {}).quantity as number;
    const result = service.setQuantity(cartId, quantity);
    if (!result.ok) {
      sendError(res, result.error);
      return;
    }
    res.status(200).json(result.value);
  });

  // Req. 3.4 / 4.5: vacía el Cart (total 0 CLP); Cart inexistente → 404.
  router.delete('/:cartId/items', (req: Request, res: Response) => {
    const cartId = req.params.cartId as string;
    const result = service.removeProduct(cartId);
    if (!result.ok) {
      sendError(res, result.error);
      return;
    }
    res.status(200).json(result.value);
  });

  return router;
}

/**
 * Instancia por defecto compartida por el proceso, lista para montar en `app`
 * (se monta en la tarea 11.4). Las pruebas pueden crear routers aislados con
 * `createCartRouter(service)`.
 */
export const cartRouter: Router = createCartRouter();
