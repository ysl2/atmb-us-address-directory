import {
  getPublicAddressesPageData,
  parsePublicAddressFilters,
  type PublicAddressesPageData,
  type PublicAddressFilters,
} from './public-address-data';

export const PUBLIC_RESIDENTIAL_RESULT_HASH = '#residential-list-title';

export interface PublicResidentialAddressFilters {
  q: string;
  cmra: string;
  minPrice: string;
  maxPrice: string;
  priceError: string;
  page: number;
}

type SearchParams = Record<string, string | string[] | undefined>;

export async function getPublicResidentialAddressesPageData(
  filters: PublicResidentialAddressFilters,
): Promise<PublicAddressesPageData> {
  return getPublicAddressesPageData(toAddressFilters(filters));
}

export function parsePublicResidentialAddressFilters(
  searchParams: SearchParams = {},
): PublicResidentialAddressFilters {
  const filters = parsePublicAddressFilters(searchParams);

  return {
    q: filters.q,
    cmra: filters.cmra,
    minPrice: filters.minPrice,
    maxPrice: filters.maxPrice,
    priceError: filters.priceError,
    page: filters.page,
  };
}

export function buildResidentialAddressesPageUrl(
  filters: PublicResidentialAddressFilters,
  overrides: Partial<PublicResidentialAddressFilters> = {},
) {
  const nextFilters: PublicResidentialAddressFilters = { ...filters, ...overrides };
  const params = new URLSearchParams();

  if (nextFilters.q) params.set('q', nextFilters.q);
  if (nextFilters.cmra) params.set('cmra', nextFilters.cmra);
  if (nextFilters.minPrice) params.set('minPrice', nextFilters.minPrice);
  if (nextFilters.maxPrice) params.set('maxPrice', nextFilters.maxPrice);
  if (nextFilters.page > 1) params.set('page', String(nextFilters.page));

  const query = params.toString();
  return `${query ? `/residential-addresses?${query}` : '/residential-addresses'}${PUBLIC_RESIDENTIAL_RESULT_HASH}`;
}

function toAddressFilters(filters: PublicResidentialAddressFilters): PublicAddressFilters {
  return {
    q: filters.q,
    state: '',
    rdi: 'Residential',
    cmra: filters.cmra,
    minPrice: filters.minPrice,
    maxPrice: filters.maxPrice,
    priceError: filters.priceError,
    page: filters.page,
  };
}
