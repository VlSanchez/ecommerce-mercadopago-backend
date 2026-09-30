/**
 * Validación de configuración de arranque para producción.
 *
 * Verifica que los secretos productivos estén presentes y bien formados ANTES
 * de arrancar el servidor. Las reglas solo aplican cuando `APP_ENV === 'production'`.
 *
 * IMPORTANTE: las violaciones referencian la variable ofensora SOLO por nombre;
 * NUNCA incluyen el valor del secreto (Req. 5.5).
 *
 * Referencia de diseño: design.md → validación de arranque (Req. 4.1, 4.3, 5.4, 5.5).
 */
import { isProductionEnv, type AppConfig } from '../config.js';

/** Prefijo esperado para un Access Token productivo de MercadoPago. */
const PRODUCTION_TOKEN_PREFIX = 'APP_USR-';

/**
 * Una violación de la configuración productiva. Referencia la variable por nombre
 * y el motivo, sin exponer nunca el valor del secreto.
 */
export interface ProductionConfigViolation {
  /** Nombre de la variable de entorno ofensora (p. ej. `'MP_ACCESS_TOKEN'`). */
  variable: string;
  /** Motivo de la violación. */
  reason: 'missing' | 'not_production_token';
}

/** Resultado de validar la configuración productiva. */
export interface ProductionConfigResult {
  /** `true` sii no hay violaciones. */
  ok: boolean;
  /** Lista de violaciones detectadas (vacía cuando `ok === true`). */
  violations: ProductionConfigViolation[];
}

/**
 * Valida la configuración productiva.
 *
 * Las reglas solo se activan en producción, determinado por `isProductionEnv(env)`:
 * `APP_ENV === 'production'` activa el modo producción y `APP_ENV` explícito prevalece
 * sobre `NODE_ENV` (que solo se consulta como respaldo si `APP_ENV` está ausente).
 * Fuera de producción se devuelve `{ ok: true, violations: [] }` sin evaluar reglas.
 *
 * Reglas (solo en producción):
 * - `MP_ACCESS_TOKEN`: presente, no vacío y con prefijo `APP_USR-`. Ausente/vacío
 *   ⇒ `'missing'`; presente con prefijo incorrecto ⇒ `'not_production_token'`.
 * - `MP_WEBHOOK_SECRET`: presente y no vacío. Ausente/vacío ⇒ `'missing'`.
 *
 * @param config Configuración cargada (fuente de los valores de secretos).
 * @param env Entorno del proceso; se usa para leer `APP_ENV`.
 */
export function validateProductionConfig(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
): ProductionConfigResult {
  if (!isProductionEnv(env)) {
    return { ok: true, violations: [] };
  }

  const violations: ProductionConfigViolation[] = [];

  const accessToken = config.mpAccessToken;
  if (!accessToken) {
    violations.push({ variable: 'MP_ACCESS_TOKEN', reason: 'missing' });
  } else if (!accessToken.startsWith(PRODUCTION_TOKEN_PREFIX)) {
    violations.push({ variable: 'MP_ACCESS_TOKEN', reason: 'not_production_token' });
  }

  if (!config.mpWebhookSecret) {
    violations.push({ variable: 'MP_WEBHOOK_SECRET', reason: 'missing' });
  }

  return { ok: violations.length === 0, violations };
}
