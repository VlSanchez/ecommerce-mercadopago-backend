/**
 * Logger — registra la traza de operaciones del sistema de forma no bloqueante.
 *
 * Referencia de diseño: design.md → Logger / Properties 18, 19, 20.
 * Requerimientos:
 * - 7.1: cada entrada incluye timestamp ISO 8601 con ms, tipo de operación y
 *   resultado en `{exito, fallo}`.
 * - 7.2: ante un error se registra el mensaje, el tipo de operación y el identificador
 *   asociado, sin interrumpir la operación en curso.
 * - 7.3: los eventos de pago incluyen el id de la Order y el estado del pago en
 *   `{pendiente, aprobado, rechazado}`.
 * - 7.4: si el registro falla, la operación de negocio continúa sin bloquearse y
 *   conserva su resultado (las escrituras se envuelven en un `try/catch` interno).
 * - 7.5: cada escritura se completa en un máximo de 500 ms (escritura síncrona).
 */

/** Resultado de una operación registrada. Vocabulario del dominio (Req. 7.1). */
export type OperationOutcome = 'exito' | 'fallo';

/** Estado de pago registrado en un evento de pago (Req. 7.3). */
export type PaymentLogStatus = 'pendiente' | 'aprobado' | 'rechazado';

/**
 * Entrada de log de una operación de negocio (Cart, Order o pago).
 * Estructura común garantizada por los métodos públicos del Logger.
 */
export interface OperationLogEntry {
  /** Marca de tiempo ISO 8601 con precisión de milisegundos (Req. 7.1). */
  timestamp: string;
  /** Tipo/nombre de la operación registrada (Req. 7.1). */
  operation: string;
  /** Resultado de la operación (Req. 7.1). */
  outcome: OperationOutcome;
  /** Identificador asociado a la operación, cuando aplica (Req. 7.2). */
  id?: string;
  /** Mensaje descriptivo del error, presente cuando `outcome === 'fallo'` (Req. 7.2). */
  errorMessage?: string;
  /** Datos adicionales de contexto (no sensibles). */
  details?: Record<string, unknown>;
}

/** Entrada de log específica de un evento de pago (Req. 7.3). */
export interface PaymentLogEntry extends OperationLogEntry {
  /** Identificador de la Order asociada al evento de pago (Req. 7.3). */
  orderId: string;
  /** Estado del pago en el vocabulario de dominio (Req. 7.3). */
  paymentStatus: PaymentLogStatus;
}

/** Función que persiste una entrada de log (por defecto, salida por consola). */
export type LogSink = (entry: OperationLogEntry) => void;

/** Contrato público del Logger. */
export interface Logger {
  /**
   * Registra una operación exitosa de Cart u Order.
   * @param operation tipo de operación (p. ej. "cart.addProduct").
   * @param id identificador asociado (id de Cart u Order), si aplica.
   * @param details contexto adicional no sensible.
   */
  logSuccess(operation: string, id?: string, details?: Record<string, unknown>): void;
  /**
   * Registra un fallo de operación, incluyendo el mensaje de error, el tipo de
   * operación y el identificador asociado (Req. 7.2). Nunca interrumpe la operación.
   */
  logFailure(
    operation: string,
    errorMessage: string,
    id?: string,
    details?: Record<string, unknown>,
  ): void;
  /**
   * Registra un evento de pago con el id de la Order y el estado del pago (Req. 7.3).
   */
  logPaymentEvent(
    orderId: string,
    paymentStatus: PaymentLogStatus,
    outcome?: OperationOutcome,
    details?: Record<string, unknown>,
  ): void;
}

/**
 * Sink por defecto: imprime la entrada como JSON en la salida estándar.
 * Es síncrono, por lo que la escritura se completa muy por debajo de los 500 ms (Req. 7.5).
 */
const defaultSink: LogSink = (entry) => {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
};

/**
 * Genera la marca de tiempo actual en ISO 8601 con precisión de milisegundos.
 * `Date.prototype.toISOString()` produce siempre el formato `YYYY-MM-DDTHH:mm:ss.sssZ`.
 */
function isoTimestampWithMillis(): string {
  return new Date().toISOString();
}

/**
 * Crea una instancia del Logger.
 *
 * Toda escritura se envuelve en un `try/catch` interno (Req. 7.4): si el sink lanza,
 * el fallo se traga sin propagarse para que la operación de negocio conserve su
 * resultado y no se bloquee.
 *
 * @param sink destino de las entradas de log; por defecto escribe JSON por consola.
 */
export function createLogger(sink: LogSink = defaultSink): Logger {
  /** Escritura resiliente: nunca propaga fallos del logging (Req. 7.4). */
  function write(entry: OperationLogEntry): void {
    try {
      sink(entry);
    } catch {
      // El logging no debe bloquear ni interrumpir la operación de negocio (Req. 7.4).
      // Se ignora cualquier fallo del sink de forma intencional.
    }
  }

  function logSuccess(
    operation: string,
    id?: string,
    details?: Record<string, unknown>,
  ): void {
    write({
      timestamp: isoTimestampWithMillis(),
      operation,
      outcome: 'exito',
      ...(id !== undefined ? { id } : {}),
      ...(details !== undefined ? { details } : {}),
    });
  }

  function logFailure(
    operation: string,
    errorMessage: string,
    id?: string,
    details?: Record<string, unknown>,
  ): void {
    write({
      timestamp: isoTimestampWithMillis(),
      operation,
      outcome: 'fallo',
      errorMessage,
      ...(id !== undefined ? { id } : {}),
      ...(details !== undefined ? { details } : {}),
    });
  }

  function logPaymentEvent(
    orderId: string,
    paymentStatus: PaymentLogStatus,
    outcome: OperationOutcome = 'exito',
    details?: Record<string, unknown>,
  ): void {
    const entry: PaymentLogEntry = {
      timestamp: isoTimestampWithMillis(),
      operation: 'payment.event',
      outcome,
      id: orderId,
      orderId,
      paymentStatus,
      ...(details !== undefined ? { details } : {}),
    };
    write(entry);
  }

  return { logSuccess, logFailure, logPaymentEvent };
}

/**
 * Instancia por defecto compartida por el proceso.
 * Los servicios de dominio la consumen; las pruebas pueden crear instancias aisladas
 * con `createLogger(sinkPersonalizado)` para observar las entradas emitidas.
 */
export const logger: Logger = createLogger();
