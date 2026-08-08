interface PublicPriceRangeFieldsProps {
  idPrefix: string;
  minPrice: string;
  maxPrice: string;
  error: string;
}

export function PublicPriceRangeFields({
  idPrefix,
  minPrice,
  maxPrice,
  error,
}: PublicPriceRangeFieldsProps) {
  const errorId = `${idPrefix}-price-error`;

  return (
    <fieldset
      className="addresses-price-range-field"
      aria-describedby={error ? errorId : undefined}
    >
      <legend>价格区间（US$ / 月）</legend>
      <div className="addresses-price-range-inputs">
        <label className="addresses-price-input">
          <span className="home-visually-hidden">最低价格</span>
          <input
            aria-invalid={error ? true : undefined}
            defaultValue={minPrice}
            inputMode="decimal"
            min="0"
            name="minPrice"
            placeholder="最低"
            step="0.01"
            type="number"
          />
        </label>
        <span aria-hidden="true">–</span>
        <label className="addresses-price-input">
          <span className="home-visually-hidden">最高价格</span>
          <input
            aria-invalid={error ? true : undefined}
            defaultValue={maxPrice}
            inputMode="decimal"
            min="0"
            name="maxPrice"
            placeholder="最高"
            step="0.01"
            type="number"
          />
        </label>
      </div>
    </fieldset>
  );
}
