import {
  ok,
  err,
  PRODUCT,
  productUnavailableError,
  type Product,
  type CatalogError,
  type Result,
} from '../models/index.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';

/**
 * Catalog_Service — expone la información del único Product del catálogo.
 *
 * Referencia de diseño: design.md → Components and Interfaces / Catalog_Service.
 * Requerimientos:
 * - 1.1: con el Product disponible, retorna nombre, descripción y precio del Product.
 * - 1.2: el precio se expresa como 2000 con la moneda CLP explícita (garantizado por
 *   la constante inmutable `PRODUCT`).
 * - 1.3: retorna exactamente un Product.
 * - 1.5: si el Product no está disponible, retorna un error `PRODUCT_UNAVAILABLE` sin
 *   devolver datos parciales del Product.
 * - 7.1: cada consulta se registra vía Logger con su resultado en `{exito, fallo}`.
 */

/** Nombre de operación usado en las entradas de log del Catalog_Service. */
const OPERATION = 'catalog.getProduct';

/** Contrato público del Catalog_Service. */
export interface CatalogService {
  /**
   * Retorna el Product único del catálogo cuando está disponible (Req. 1.1, 1.3).
   * Si el Product no está disponible retorna `PRODUCT_UNAVAILABLE` sin datos
   * parciales del Product (Req. 1.5).
   */
  getProduct(): Result<Product, CatalogError>;
}

/**
 * Crea una instancia del Catalog_Service.
 *
 * @param logger Logger para registrar la traza de la operación (Req. 7.1). Por defecto
 *   usa la instancia compartida del proceso; las pruebas pueden inyectar una aislada.
 */
export function createCatalogService(logger: Logger = defaultLogger): CatalogService {
  function getProduct(): Result<Product, CatalogError> {
    // Req. 1.5: si el Product no está disponible se retorna un error sin datos parciales.
    if (!PRODUCT.available) {
      const error = productUnavailableError();
      logger.logFailure(OPERATION, error.message, PRODUCT.id);
      return err(error);
    }

    // Req. 1.1/1.2/1.3: se retorna exactamente un Product con nombre, descripción,
    // precio (2000) y moneda (CLP) explícitos, provistos por la constante inmutable.
    logger.logSuccess(OPERATION, PRODUCT.id);
    return ok(PRODUCT);
  }

  return { getProduct };
}

/**
 * Instancia por defecto compartida por el proceso.
 * Los routers/consumidores la usan directamente; las pruebas pueden crear instancias
 * aisladas con `createCatalogService(loggerPersonalizado)`.
 */
export const catalogService: CatalogService = createCatalogService();
