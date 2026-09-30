/**
 * PreferenceRequest — objeto de request a MercadoPago para iniciar el Checkout Pro.
 *
 * Referencia de diseño: design.md → Data Models / Preference.
 * `external_reference` correlaciona la notificación (webhook) con la Order.id.
 */
export interface PreferenceRequestItem {
  id: string;
  title: string;
  /** Descripción del ítem (checklist de homologación: `item_description`). */
  description?: string;
  /** URL de la imagen del ítem (checklist de homologación: `picture_url`). */
  picture_url?: string;
  quantity: number;
  /** entero CLP */
  unit_price: number;
  currency_id: 'CLP';
}

export interface PreferenceRequest {
  items: PreferenceRequestItem[];
  /** Order.id (para correlacionar el webhook). */
  external_reference: string;
  back_urls: {
    success: string;
    failure: string;
    pending: string;
  };
  /**
   * `auto_return` es CONDICIONAL: MercadoPago solo lo acepta cuando `back_urls.success`
   * es una URL pública. Con back_urls locales (localhost/127.0.0.1) la API rechaza la
   * preferencia con `invalid_auto_return`, por lo que el campo se OMITE en desarrollo.
   */
  auto_return?: 'approved';
  /**
   * Texto que aparece en el resumen de tarjeta del comprador (checklist de homologación:
   * `statement_descriptor`). Mejora la aprobación y el reconocimiento del cargo.
   */
  statement_descriptor?: string;
  /**
   * Datos del comprador (checklist de homologación: `payer.email`, `payer.last_name`).
   * En la API de preferencias el apellido es `surname`. Opcional: se completa solo cuando
   * el sistema captura datos reales del comprador (no se inventan datos).
   */
  payer?: { email?: string; name?: string; surname?: string };
  /**
   * Configuración de medios de pago del Checkout (checklist de homologación).
   * - `installments`: número máximo de cuotas ofrecidas.
   * - `excluded_payment_methods`: marcas de tarjeta a excluir (p. ej. Visa → id 'visa').
   * - `excluded_payment_types`: tipos de medio de pago a excluir (opcional).
   */
  payment_methods?: {
    installments?: number;
    excluded_payment_methods?: { id: string }[];
    excluded_payment_types?: { id: string }[];
  };
  /** endpoint del webhook del backend. */
  notification_url: string;
}
