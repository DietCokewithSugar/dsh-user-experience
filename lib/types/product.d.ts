import type { OutputLanguage } from './i18n';
/** 产品/业务类型决定走查重点，不改变规则的证据门槛。 */
export type ProductType = 'consumer' | 'enterprise' | 'ecommerce' | 'content' | 'finance' | 'healthcare' | 'developer-tool' | 'internal-tool' | 'other';
export declare const PRODUCT_TYPES: readonly ProductType[];
export declare function normalizeProductType(value: string | undefined): ProductType;
export declare function productReviewFocus(type: ProductType, language: OutputLanguage): readonly string[];
