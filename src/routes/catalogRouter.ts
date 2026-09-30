import { Router, type Request, type Response } from 'express';
import { catalogService as defaultCatalogService } from '../services/catalogService.js';
import type { CatalogService } from '../services/catalogService.js';

/**
 * Router de catálogo — expone el único Product del catálogo vía HTTP.
 *
 * Referencia de diseño: design.md → Structure (routes/catalog) y Error Handling.
 * Requerimientos:
 * - 1.1: `GET /product` retorna el nombre, la descripción y el precio del Product único
 *   con HTTP 200 cuando está disponible.
 * - 1.5: si el Product no está disponible, el Catalog_Service retorna
 *   `PRODUCT_UNAVAILABLE`; el router lo mapea a HTTP 404 sin devolver datos parciales.
 *
 * Nota de montaje: este router se monta bajo el prefijo `/api` en `app` (tarea 11.4),
 * por lo que la ruta efectiva expuesta al cliente es `GET /api/product`. Este archivo
 * NO monta el router en `app.ts`.
 */

/**
 * Código HTTP al que mapea `PRODUCT_UNAVAILABLE`.
 *
 * La tabla de Error Handling del diseño indica 404/503 para este código; se usa 404
 * (recurso no disponible/ausente) de forma consistente con el resto de los "no
 * encontrado/no disponible" de la API.
 */
const PRODUCT_UNAVAILABLE_STATUS = 404;

/**
 * Crea el Router de catálogo.
 *
 * @param service Instancia del Catalog_Service en la que se delega la consulta del
 *   Product. Por defecto usa la instancia compartida del proceso; las pruebas pueden
 *   inyectar una aislada (mismo patrón `createX(service)` de los servicios).
 */
export function createCatalogRouter(service: CatalogService = defaultCatalogService): Router {
  const router = Router();

  /**
   * GET /product — retorna el Product único del catálogo (Req. 1.1, 1.5).
   *
   * - Éxito: HTTP 200 con el Product como JSON (nombre, descripción, precio, moneda).
   * - `PRODUCT_UNAVAILABLE`: HTTP 404 con el cuerpo de error consistente de la app
   *   `{ error: { code, message } }`, sin datos parciales del Product.
   */
  router.get('/product', (_req: Request, res: Response) => {
    const result = service.getProduct();

    // Req. 1.5: ante Product no disponible se responde el error sin datos parciales.
    if (!result.ok) {
      const { code, message } = result.error;
      res.status(PRODUCT_UNAVAILABLE_STATUS).json({ error: { code, message } });
      return;
    }

    // Req. 1.1: se retorna el Product único disponible.
    res.status(200).json(result.value);
  });

  return router;
}

/**
 * Instancia por defecto del router configurada con el Catalog_Service compartido.
 * Se usa para montarlo en `app` (tarea 11.4); las pruebas pueden crear routers
 * aislados con `createCatalogRouter(servicioPersonalizado)`.
 */
export const catalogRouter: Router = createCatalogRouter();
