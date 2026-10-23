/**
 * GURPS Item Sheet: Modern
 *
 * The module has two parts:
 *  1. Visual: restyles the GURPS item sheet to match the Modern character sheet,
 *     enables Foundry window resizing and remembers the window size.
 *  2. Ammunition: links ranged weapon items ("Shots"/"Бзс") to per-actor GURPS
 *     Resource Trackers, spends shots on attacks and adds a manual ammo panel to
 *     the Modern actor sheet.
 *
 * The item template, data preparation, listeners, drag & drop and the item update
 * logic are never replaced.
 */

import { registerAmmoAttackHook } from './ammo/attack.mjs';
import { registerAmmoSyncHooks } from './ammo/sync.mjs';
import { registerAmmoUiHooks } from './ammo/ui.mjs';

const MODULE_ID = 'gurps-item-modern';
const SHEET_CLASS = 'gurps-item-modern';
const SIZE_SETTING = 'windowSize';
const PATCHED = Symbol.for(`${MODULE_ID}.patched`);

const DEFAULT_SIZE = Object.freeze({ width: 760, height: 720 });
const MIN_SIZE = Object.freeze({ width: 680, height: 420 });

const GURPS_ITEM_SHEET_ID = 'gurps.GurpsItemSheet';
const GURPS_ITEM_TEMPLATE = 'systems/gurps/templates/item/item-sheet.hbs';

/* -------------------------------------------- */
/*  Settings                                    */
/* -------------------------------------------- */

Hooks.once('init', () => {
  game.settings.register(MODULE_ID, SIZE_SETTING, {
    name: 'GURPSITEMODERN.Settings.WindowSize.Name',
    hint: 'GURPSITEMODERN.Settings.WindowSize.Hint',
    scope: 'client',
    config: false,
    type: Object,
    default: { ...DEFAULT_SIZE },
  });

  game.settings.register(MODULE_ID, 'autoCreateAmmo', {
    name: 'GURPSITEMODERN.Settings.AutoCreateAmmo.Name',
    hint: 'GURPSITEMODERN.Settings.AutoCreateAmmo.Hint',
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, 'blockWhenEmpty', {
    name: 'GURPSITEMODERN.Settings.BlockWhenEmpty.Name',
    hint: 'GURPSITEMODERN.Settings.BlockWhenEmpty.Hint',
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, 'respectExternalAmmo', {
    name: 'GURPSITEMODERN.Settings.RespectExternalAmmo.Name',
    hint: 'GURPSITEMODERN.Settings.RespectExternalAmmo.Hint',
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  });
});

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

/**
 * Read the last stored window size, falling back to safe defaults.
 * @returns {{width: number, height: number}}
 */
function getStoredSize() {
  try {
    const stored = game.settings.get(MODULE_ID, SIZE_SETTING) ?? {};
    return {
      width: clampSize(stored.width, MIN_SIZE.width, DEFAULT_SIZE.width),
      height: clampSize(stored.height, MIN_SIZE.height, DEFAULT_SIZE.height),
    };
  } catch (err) {
    return { ...DEFAULT_SIZE };
  }
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} fallback
 * @returns {number}
 */
function clampSize(value, min, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.round(number));
}

/**
 * Persist the window size for this client.
 * @param {{width?: number, height?: number}} position
 */
function storeSize(position) {
  const width = Math.round(Number(position?.width));
  const height = Math.round(Number(position?.height));
  if (!Number.isFinite(width) || !Number.isFinite(height)) return;

  game.settings
    .set(MODULE_ID, SIZE_SETTING, {
      width: Math.max(MIN_SIZE.width, width),
      height: Math.max(MIN_SIZE.height, height),
    })
    .catch(err => console.warn(`${MODULE_ID} | Unable to store window size`, err));
}

/**
 * Whether the given class is the GURPS item sheet shipped by the system.
 * @param {Function} cls
 * @returns {boolean}
 */
function isGurpsItemSheet(cls) {
  if (typeof cls !== 'function') return false;
  if (cls.name === 'GurpsItemSheet') return true;

  try {
    return cls.defaultOptions?.template === GURPS_ITEM_TEMPLATE;
  } catch (err) {
    return false;
  }
}

/* -------------------------------------------- */
/*  Sheet class                                 */
/* -------------------------------------------- */

/**
 * Create a thin subclass of the system item sheet which only adjusts window options.
 * @param {Function} BaseSheet
 * @returns {Function}
 */
function createModernSheetClass(BaseSheet) {
  if (BaseSheet[PATCHED]) return BaseSheet;

  class GurpsItemModernSheet extends BaseSheet {
    /** @override */
    static get defaultOptions() {
      const base = super.defaultOptions;
      const size = getStoredSize();
      const classes = Array.from(new Set([...(base.classes ?? []), SHEET_CLASS]));

      return foundry.utils.mergeObject(
        base,
        {
          classes,
          resizable: true,
          width: size.width,
          height: size.height,
        },
        { inplace: false }
      );
    }

    /** @override */
    _onResize(event) {
      super._onResize?.(event);
      storeSize(this.position);
    }
  }

  Object.defineProperty(GurpsItemModernSheet, PATCHED, { value: true });
  return GurpsItemModernSheet;
}

/* -------------------------------------------- */
/*  Bootstrap                                   */
/* -------------------------------------------- */

/**
 * `CONFIG.Item.sheetClasses` is only populated by DocumentSheetConfig.initializeSheets()
 * after the `setup` hook, so the registry is patched on `ready`. No item sheet can be
 * instantiated before that point, therefore the default class is replaced safely.
 */
Hooks.once('ready', () => {
  if (game.system?.id !== 'gurps') return;

  registerAmmoSyncHooks();
  registerAmmoAttackHook();
  registerAmmoUiHooks();

  const sheetClasses = CONFIG.Item?.sheetClasses;
  if (!sheetClasses) return;

  const cache = new Map();
  let patched = 0;

  for (const type of Object.keys(sheetClasses)) {
    for (const config of Object.values(sheetClasses[type] ?? {})) {
      const BaseSheet = config?.cls;
      if (typeof BaseSheet !== 'function') continue;

      const isTarget = config?.id === GURPS_ITEM_SHEET_ID || isGurpsItemSheet(BaseSheet);
      if (!isTarget) continue;

      let ModernSheet = cache.get(BaseSheet);
      if (!ModernSheet) {
        ModernSheet = createModernSheetClass(BaseSheet);
        cache.set(BaseSheet, ModernSheet);
      }

      config.cls = ModernSheet;
      patched += 1;
    }
  }

  if (!patched) {
    console.warn(
      `${MODULE_ID} | Could not find the GURPS item sheet class. ` +
        `The module is inactive until the GURPS system exposes "${GURPS_ITEM_SHEET_ID}".`
    );
    return;
  }

  console.debug(`${MODULE_ID} | Modern styling enabled for ${patched} item sheet entr${patched === 1 ? 'y' : 'ies'}.`);
});
