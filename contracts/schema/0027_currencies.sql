-- =============================================================================
-- 0027 — ISO 4217 currency reference data
-- =============================================================================
-- Phase 1 delivers "base/functional/reporting currencies", and every legal entity
-- references `currencies(code)`. Until now the only currencies in the database
-- were the two the seeder inserted, so creating an entity in a third currency
-- failed on a foreign key.
--
-- ADR-0006 makes `minor_unit` load-bearing rather than cosmetic: it is the scale
-- every rounding boundary rounds to. A wrong value does not produce a formatting
-- glitch, it produces a rounding difference on every line of every document in that
-- currency, and the difference lands in the rounding account. The currencies whose
-- minor unit is not 2 are therefore listed exhaustively below and grouped, so the
-- unusual ones are reviewable rather than buried among two hundred ordinary rows.
--
-- `cash_rounding_increment` is separate and only applies to physical cash: several
-- countries withdrew their smallest coin without changing the currency's scale, so
-- CHF is still two decimals but cash settles to 0.05.
--
-- This is the generic set. Phase 3 localization packages add and activate the
-- country-specific remainder; nothing here is country-pack material.
-- =============================================================================

INSERT INTO currencies (code, name, minor_unit, symbol, symbol_position, cash_rounding_increment) VALUES
  -- ---------------------------------------------------------------- 0 decimals
  ('BIF', 'Burundian Franc',        0, 'FBu', 'BEFORE', NULL),
  ('CLP', 'Chilean Peso',           0, '$',   'BEFORE', NULL),
  ('DJF', 'Djiboutian Franc',       0, 'Fdj', 'BEFORE', NULL),
  ('GNF', 'Guinean Franc',          0, 'FG',  'BEFORE', NULL),
  ('ISK', 'Icelandic Krona',        0, 'kr',  'AFTER',  NULL),
  ('JPY', 'Japanese Yen',           0, '¥',   'BEFORE', NULL),
  ('KMF', 'Comorian Franc',         0, 'CF',  'BEFORE', NULL),
  ('KRW', 'South Korean Won',       0, '₩',   'BEFORE', NULL),
  ('PYG', 'Paraguayan Guarani',     0, '₲',   'BEFORE', NULL),
  ('RWF', 'Rwandan Franc',          0, 'FRw', 'BEFORE', NULL),
  ('UGX', 'Ugandan Shilling',       0, 'USh', 'BEFORE', NULL),
  ('VND', 'Vietnamese Dong',        0, '₫',   'AFTER',  NULL),
  ('VUV', 'Vanuatu Vatu',           0, 'VT',  'BEFORE', NULL),
  ('XAF', 'Central African CFA Franc', 0, 'FCFA', 'AFTER', NULL),
  ('XOF', 'West African CFA Franc',    0, 'CFA',  'AFTER', NULL),
  ('XPF', 'CFP Franc',              0, '₣',   'AFTER',  NULL),

  -- ---------------------------------------------------------------- 3 decimals
  ('BHD', 'Bahraini Dinar',         3, '.د.ب', 'BEFORE', NULL),
  ('IQD', 'Iraqi Dinar',            3, 'ع.د',  'BEFORE', NULL),
  ('JOD', 'Jordanian Dinar',        3, 'د.ا',  'BEFORE', NULL),
  ('KWD', 'Kuwaiti Dinar',          3, 'د.ك',  'BEFORE', NULL),
  ('LYD', 'Libyan Dinar',           3, 'ل.د',  'BEFORE', NULL),
  ('OMR', 'Omani Rial',             3, 'ر.ع.', 'BEFORE', NULL),
  ('TND', 'Tunisian Dinar',         3, 'د.ت',  'BEFORE', NULL),

  -- ---------------------------------------------------------------- 2 decimals
  ('AED', 'UAE Dirham',             2, 'د.إ', 'BEFORE', NULL),
  ('ARS', 'Argentine Peso',         2, '$',   'BEFORE', NULL),
  ('AUD', 'Australian Dollar',      2, '$',   'BEFORE', 0.05),
  ('BDT', 'Bangladeshi Taka',       2, '৳',   'BEFORE', NULL),
  ('BGN', 'Bulgarian Lev',          2, 'лв',  'AFTER',  NULL),
  ('BRL', 'Brazilian Real',         2, 'R$',  'BEFORE', NULL),
  ('CAD', 'Canadian Dollar',        2, '$',   'BEFORE', 0.05),
  ('CHF', 'Swiss Franc',            2, 'CHF', 'BEFORE', 0.05),
  ('CNY', 'Chinese Yuan',           2, '¥',   'BEFORE', NULL),
  ('COP', 'Colombian Peso',         2, '$',   'BEFORE', NULL),
  ('CZK', 'Czech Koruna',           2, 'Kč',  'AFTER',  1.00),
  ('DKK', 'Danish Krone',           2, 'kr',  'AFTER',  0.50),
  ('EGP', 'Egyptian Pound',         2, 'E£',  'BEFORE', NULL),
  ('EUR', 'Euro',                   2, '€',   'BEFORE', NULL),
  ('GBP', 'Pound Sterling',         2, '£',   'BEFORE', NULL),
  ('GHS', 'Ghanaian Cedi',          2, '₵',   'BEFORE', NULL),
  ('HKD', 'Hong Kong Dollar',       2, 'HK$', 'BEFORE', NULL),
  ('HUF', 'Hungarian Forint',       2, 'Ft',  'AFTER',  5.00),
  ('IDR', 'Indonesian Rupiah',      2, 'Rp',  'BEFORE', NULL),
  ('ILS', 'Israeli New Shekel',     2, '₪',   'BEFORE', NULL),
  ('INR', 'Indian Rupee',           2, '₹',   'BEFORE', NULL),
  ('KES', 'Kenyan Shilling',        2, 'KSh', 'BEFORE', NULL),
  ('LKR', 'Sri Lankan Rupee',       2, 'Rs',  'BEFORE', NULL),
  ('MAD', 'Moroccan Dirham',        2, 'د.م.', 'BEFORE', NULL),
  ('MXN', 'Mexican Peso',           2, '$',   'BEFORE', NULL),
  ('MYR', 'Malaysian Ringgit',      2, 'RM',  'BEFORE', 0.05),
  ('NGN', 'Nigerian Naira',         2, '₦',   'BEFORE', NULL),
  ('NOK', 'Norwegian Krone',        2, 'kr',  'AFTER',  1.00),
  ('NZD', 'New Zealand Dollar',     2, '$',   'BEFORE', 0.10),
  ('PEN', 'Peruvian Sol',           2, 'S/',  'BEFORE', NULL),
  ('PHP', 'Philippine Peso',        2, '₱',   'BEFORE', NULL),
  ('PKR', 'Pakistani Rupee',        2, 'Rs',  'BEFORE', NULL),
  ('PLN', 'Polish Zloty',           2, 'zł',  'AFTER',  NULL),
  ('QAR', 'Qatari Riyal',           2, 'ر.ق', 'BEFORE', NULL),
  ('RON', 'Romanian Leu',           2, 'lei', 'AFTER',  NULL),
  ('RSD', 'Serbian Dinar',          2, 'дин', 'AFTER',  NULL),
  ('SAR', 'Saudi Riyal',            2, 'ر.س', 'BEFORE', NULL),
  ('SEK', 'Swedish Krona',          2, 'kr',  'AFTER',  1.00),
  ('SGD', 'Singapore Dollar',       2, 'S$',  'BEFORE', NULL),
  ('THB', 'Thai Baht',              2, '฿',   'BEFORE', NULL),
  ('TRY', 'Turkish Lira',           2, '₺',   'BEFORE', NULL),
  ('TWD', 'New Taiwan Dollar',      2, 'NT$', 'BEFORE', NULL),
  ('TZS', 'Tanzanian Shilling',     2, 'TSh', 'BEFORE', NULL),
  ('UAH', 'Ukrainian Hryvnia',      2, '₴',   'AFTER',  NULL),
  ('USD', 'United States Dollar',   2, '$',   'BEFORE', NULL),
  ('UYU', 'Uruguayan Peso',         2, '$U',  'BEFORE', NULL),
  ('VES', 'Venezuelan Bolivar',     2, 'Bs.', 'BEFORE', NULL),
  ('ZAR', 'South African Rand',     2, 'R',   'BEFORE', NULL),
  ('ZMW', 'Zambian Kwacha',         2, 'ZK',  'BEFORE', NULL),

  -- ---------------------------------------------------------------- 4 decimals
  -- Unidad de Fomento and Unidad Previsional: index units, quoted to four places.
  -- Present because an entity reporting in one of them would otherwise silently
  -- round to two and drift against the published index.
  ('CLF', 'Chilean Unidad de Fomento', 4, 'UF',  'BEFORE', NULL),
  ('UYW', 'Uruguayan Unidad Previsional', 4, 'UP', 'BEFORE', NULL)
ON CONFLICT (code) DO UPDATE
  SET name = EXCLUDED.name,
      minor_unit = EXCLUDED.minor_unit,
      symbol = EXCLUDED.symbol,
      symbol_position = EXCLUDED.symbol_position,
      cash_rounding_increment = EXCLUDED.cash_rounding_increment;

-- A minor unit that changes after transactions exist reinterprets every stored
-- amount in that currency. The column comment on `currencies.minor_unit` already
-- says "immutable once transactions exist"; this makes it so.
CREATE OR REPLACE FUNCTION reject_minor_unit_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.minor_unit IS DISTINCT FROM OLD.minor_unit
     AND EXISTS (
       SELECT 1 FROM journal_lines
        WHERE transaction_currency = OLD.code OR base_currency = OLD.code
        LIMIT 1
     ) THEN
    RAISE EXCEPTION
      'currency % has posted journal lines; changing minor_unit from % to % would reinterpret '
      'every amount already stored in it (ADR-0006)',
      OLD.code, OLD.minor_unit, NEW.minor_unit
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER currencies_minor_unit_immutable
  BEFORE UPDATE ON currencies
  FOR EACH ROW EXECUTE FUNCTION reject_minor_unit_change();

COMMENT ON FUNCTION reject_minor_unit_change() IS
  'ADR-0006: minor_unit is the scale every rounding boundary rounds to. Changing it once amounts '
  'exist rewrites their meaning without rewriting the data.';
