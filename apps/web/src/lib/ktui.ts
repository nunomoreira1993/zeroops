import { useEffect, type DependencyList } from 'react';

/** Inicializa os dropdowns KTUI (data-kt-dropdown) presentes no DOM depois de cada render relevante. */
export function useKtDropdowns(deps: DependencyList) {
  useEffect(() => {
    let active = true;
    void import('@keenthemes/ktui/components/dropdown').then(({ KTDropdown }) => {
      if (active) KTDropdown.init();
    });
    return () => {
      active = false;
    };
  }, deps);
}
