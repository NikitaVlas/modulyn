'use client';

import { createContext, useContext, type ReactNode } from 'react';

/** Бренд установки (Phase 11, E4): название продукта и логотип; цвет — CSS-переменная --brand. */
export interface BrandConfig { name: string; logoUrl: string | null }

const Context = createContext<BrandConfig>({ name: 'Modulyn', logoUrl: null });

export function BrandProvider({ brand, children }: { brand: BrandConfig; children: ReactNode }) {
  return <Context.Provider value={brand}>{children}</Context.Provider>;
}

export function useBrand(): BrandConfig {
  return useContext(Context);
}
