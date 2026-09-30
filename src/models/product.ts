/**
 * Product — el único artículo vendible del catálogo.
 *
 * Existe exactamente un Product con precio fijo de 2000 CLP (entero, sin decimales).
 * Referencia de diseño: design.md → Data Models / Product.
 */
export interface Product {
  /** Identificador estable del producto único (4 dígitos numéricos, checklist de homologación). */
  id: string;
  name: string;
  description: string;
  /** 2000 (entero, sin decimales). */
  price: number;
  /** Indicación explícita de moneda. */
  currency: 'CLP';
  available: boolean;
  /** URL de la imagen del producto; se envía como `picture_url` en la preferencia de MercadoPago (checklist de homologación). */
  imageUrl: string;
}

/**
 * Constante inmutable del catálogo. Existe exactamente un Product.
 * `as const` congela los valores literales; `Object.freeze` evita mutaciones en runtime.
 */
export const PRODUCT: Readonly<Product> = Object.freeze({
  id: '1234',
  name: 'Producto Único',
  description: 'Dispositivo de tienda móvil de comercio electrónico',
  price: 2000,
  currency: 'CLP',
  available: true,
  imageUrl:
    'https://http2.mlstatic.com/storage/dx-devsite/docs-assets/custom-upload/2025/3/28/1745869692336-MX.ES.png',
} satisfies Product);
