import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { loadConfig, type AppConfig } from './config.js';
import { logger } from './lib/logger.js';
import { catalogRouter } from './routes/catalogRouter.js';
import { cartRouter } from './routes/cartRouter.js';
import { checkoutRouter } from './routes/checkoutRouter.js';
import { webhookRouter } from './routes/webhookRouter.js';

/**
 * Nombre de operación usado por el manejador de errores global en las entradas de log.
 */
const OP_ERROR_HANDLER = 'app.errorHandler';

/**
 * Construye la aplicación Express con los middlewares base y todos los routers de dominio.
 *
 * Middlewares y montaje (design.md → Backend / server.js / app.js):
 * - CORS restringido al origen del frontend (configurable por env vía FRONTEND_ORIGIN).
 * - Webhook de MercadoPago montado ANTES de `express.json()`: su ruta usa el middleware
 *   `express.raw` para exponer el cuerpo crudo (Buffer) que la validación de firma HMAC
 *   necesita (Req. 6.6). Montarlo antes evita que el parser JSON global consuma el stream
 *   del cuerpo.
 * - `express.json()` para el resto de los endpoints (catálogo, carrito, checkout).
 * - Routers de dominio bajo el prefijo `/api`.
 * - Manejador de errores global (LAST middleware): responde 500 genérico sin filtrar
 *   detalles internos y registra el error vía Logger.
 *
 * Rutas efectivas expuestas:
 * - `GET    /api/product`
 * - `POST   /api/cart`
 * - `GET    /api/cart/:cartId`
 * - `POST   /api/cart/:cartId/items`
 * - `PATCH  /api/cart/:cartId/items`
 * - `DELETE /api/cart/:cartId/items`
 * - `POST   /api/checkout`
 * - `POST   /api/webhooks/mercadopago`
 */
export function createApp(config: AppConfig = loadConfig()): Express {
  const app = express();

  app.use(
    cors({
      origin: config.frontendOrigin,
    }),
  );

  // Webhook de MercadoPago (Req. 6.4, 6.6, 6.7): se monta ANTES de `express.json()` porque
  // su ruta aplica `express.raw()` para recibir el cuerpo crudo (Buffer) requerido por la
  // validación de firma. Si el parser JSON global corriera primero, consumiría el cuerpo y
  // la firma no podría verificarse.
  app.use('/api/webhooks/mercadopago', webhookRouter);

  // Parser JSON para el resto de los endpoints.
  app.use(express.json());

  // Health check básico para verificar que el proceso está arriba.
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  // Routers de dominio (Req. 1.x, 2.x, 3.x, 5.x). Catalog y Checkout definen sus rutas
  // relativas (`/product`, `/checkout`) y se montan bajo `/api`; Cart se monta bajo
  // `/api/cart`.
  app.use('/api', catalogRouter);
  app.use('/api/cart', cartRouter);
  app.use('/api', checkoutRouter);

  // Manejador de errores global (LAST middleware). Responde 500 genérico SIN filtrar
  // detalles internos del error y registra el fallo vía Logger. Debe conservar la firma
  // de 4 argumentos de Express para ser reconocido como manejador de errores.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    // Registro del error vía Logger (Req. 7.2). El propio Logger envuelve la escritura en
    // try/catch, pero se protege también aquí para garantizar que el manejo del error no
    // se interrumpa por un fallo del logging.
    try {
      const message = err instanceof Error ? err.message : String(err);
      logger.logFailure(OP_ERROR_HANDLER, message);
    } catch {
      // El logging nunca debe impedir responder al cliente.
    }

    // Si las cabeceras ya se enviaron, se delega al manejador por defecto de Express.
    if (res.headersSent) {
      next(err);
      return;
    }

    // Respuesta genérica: no se filtran detalles internos del error al cliente.
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Ocurrió un error interno.',
      },
    });
  });

  return app;
}
