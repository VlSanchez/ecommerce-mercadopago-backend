import { describe, it, expect } from 'vitest';
import { extractOrderId } from './paymentService.js';
import { buildPreferenceRequest, type BackUrls } from '../lib/mercadopago.js';
import { PRODUCT } from '../models/index.js';
import type { Order } from '../models/index.js';

/**
 * Pruebas del external_reference: es SIEMPRE el `Order.id` puro.
 *
 * El helper `extractOrderId` se conserva por compatibilidad/robustez: devuelve el valor tal
 * cual cuando no hay separador `|` (caso normal, `external_reference = Order.id`) y tolera un
 * eventual separador `|` recuperando la parte tras el último `|`.
 */

const BACK_URLS: BackUrls = {
  success: 'https://tienda.example.com/checkout/success',
  failure: 'https://tienda.example.com/checkout/failure',
  pending: 'https://tienda.example.com/checkout/pending',
};
const NOTIFICATION_URL = 'https://api.example.com/api/webhooks/mercadopago';

/** Order mínima válida para construir la Preference. */
function sampleOrder(id: string): Order {
  const now = new Date().toISOString();
  return {
    id,
    cartSnapshot: {
      items: [
        {
          productId: PRODUCT.id,
          quantity: 1,
          unitPrice: PRODUCT.price,
          subtotal: PRODUCT.price,
        },
      ],
      total: PRODUCT.price,
      currency: 'CLP',
    },
    amount: PRODUCT.price,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
}

describe('extractOrderId', () => {
  it('retorna undefined para undefined o cadena vacía', () => {
    expect(extractOrderId(undefined)).toBeUndefined();
    expect(extractOrderId('')).toBeUndefined();
  });

  it('extrae la parte tras el último | cuando hay separador (robustez)', () => {
    expect(extractOrderId('vladi.s095@gmail.com|order-123')).toBe('order-123');
  });

  it('usa el último segmento aunque haya varios | (robustez)', () => {
    expect(extractOrderId('a|b|order-xyz')).toBe('order-xyz');
  });

  it('retorna undefined si la parte tras | queda vacía', () => {
    expect(extractOrderId('vladi.s095@gmail.com|')).toBeUndefined();
  });

  it('retorna el valor tal cual cuando no hay | (external_reference = Order.id)', () => {
    expect(extractOrderId('order-123')).toBe('order-123');
  });
});

describe('buildPreferenceRequest — external_reference', () => {
  it('usa el Order.id puro como external_reference', () => {
    const req = buildPreferenceRequest(sampleOrder('order-abc'), {
      backUrls: BACK_URLS,
      notificationUrl: NOTIFICATION_URL,
    });
    expect(req.external_reference).toBe('order-abc');
  });

  it('round-trip: extractOrderId recupera el Order.id del external_reference (correlación preservada)', () => {
    const req = buildPreferenceRequest(sampleOrder('order-abc'), {
      backUrls: BACK_URLS,
      notificationUrl: NOTIFICATION_URL,
    });
    expect(extractOrderId(req.external_reference)).toBe('order-abc');
  });
});
