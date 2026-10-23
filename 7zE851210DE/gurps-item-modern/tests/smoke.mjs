/**
 * Minimal Foundry mocks and smoke tests for scripts/main.mjs.
 * Run with: node tests/smoke.mjs
 */

import assert from 'node:assert/strict';

/* -------------------------------------------- */
/*  Foundry mocks                               */
/* -------------------------------------------- */

function mergeObject(original, other = {}, options = {}) {
  const target = options.inplace ? original : structuredClone(original);
  for (const [key, value] of Object.entries(other)) {
    if (Array.isArray(value)) {
      const base = Array.isArray(target[key]) ? target[key] : [];
      const length = Math.max(base.length, value.length);
      target[key] = Array.from({ length }, (_, index) => (value[index] !== undefined ? value[index] : base[index]));
      continue;
    }
    const isObject = value && typeof value === 'object' && !Array.isArray(value);
    if (isObject && target[key] && typeof target[key] === 'object') {
      target[key] = mergeObject(target[key], value, { inplace: false });
      continue;
    }
    target[key] = value;
  }
  return target;
}

const hookHandlers = new Map();
globalThis.Hooks = {
  once(name, callback) {
    if (!hookHandlers.has(name)) hookHandlers.set(name, []);
    hookHandlers.get(name).push(callback);
  },
  _fire(name, ...args) {
    const handlers = hookHandlers.get(name) ?? [];
    hookHandlers.set(name, []);
    for (const handler of handlers) handler(...args);
  },
};

const settingRegistry = new Map();
const settingValues = new Map();
globalThis.game = {
  system: { id: 'gurps' },
  settings: {
    register(namespace, key, config) {
      const id = `${namespace}.${key}`;
      settingRegistry.set(id, config);
      if (!settingValues.has(id)) settingValues.set(id, structuredClone(config.default));
    },
    get(namespace, key) {
      return structuredClone(settingValues.get(`${namespace}.${key}`));
    },
    async set(namespace, key, value) {
      settingValues.set(`${namespace}.${key}`, structuredClone(value));
    },
  },
};

globalThis.CONFIG = { Item: { sheetClasses: {} } };
globalThis.foundry = { utils: { mergeObject } };

/* -------------------------------------------- */
/*  Fake system item sheet                      */
/* -------------------------------------------- */

const TEMPLATE = 'systems/gurps/templates/item/item-sheet.hbs';

class FakeGurpsItemSheet {
  static get defaultOptions() {
    return {
      classes: ['sheet', 'item'],
      template: TEMPLATE,
      width: 680,
      height: 'auto',
      resizable: false,
      tabs: [{ navSelector: '.gurps-sheet-tabs', contentSelector: '.content', initial: 'melee-tab' }],
    };
  }

  _onResize() {}
}

class OtherItemSheet {
  static get defaultOptions() {
    return { classes: ['sheet', 'item'], template: 'systems/other/item.hbs', resizable: false };
  }
}

/* -------------------------------------------- */
/*  Scenario                                    */
/* -------------------------------------------- */

CONFIG.Item.sheetClasses = {
  equipment: {
    'gurps.GurpsItemSheet': { id: 'gurps.GurpsItemSheet', label: 'GURPS', cls: FakeGurpsItemSheet, default: true },
    'other.OtherItemSheet': { id: 'other.OtherItemSheet', label: 'Other', cls: OtherItemSheet, default: false },
  },
  feature: {
    'gurps.GurpsItemSheet': { id: 'gurps.GurpsItemSheet', label: 'GURPS', cls: FakeGurpsItemSheet, default: true },
  },
  skill: {
    // Different registration id: the module must find the sheet by class name or template.
    'some-scope.GurpsItemSheet': {
      id: 'some-scope.GurpsItemSheet',
      label: 'GURPS (renamed)',
      cls: FakeGurpsItemSheet,
      default: true,
    },
  },
  spell: {
    'gurps.GurpsItemSheet': { id: 'gurps.GurpsItemSheet', label: 'GURPS', cls: FakeGurpsItemSheet, default: true },
  },
};

await import('../scripts/main.mjs');

Hooks._fire('init');
assert.ok(settingRegistry.has('gurps-item-modern.windowSize'), 'window size setting is registered');
assert.equal(settingRegistry.get('gurps-item-modern.windowSize').scope, 'client');

const readyHandlers = [...(hookHandlers.get('ready') ?? [])];
Hooks._fire('ready');

const equipment = CONFIG.Item.sheetClasses.equipment['gurps.GurpsItemSheet'];
const skill = CONFIG.Item.sheetClasses.skill['some-scope.GurpsItemSheet'];
const other = CONFIG.Item.sheetClasses.equipment['other.OtherItemSheet'];

assert.notEqual(equipment.cls, FakeGurpsItemSheet, 'equipment sheet class is replaced');
assert.equal(skill.cls, equipment.cls, 'all GURPS item types share the same modern subclass');
assert.equal(other.cls, OtherItemSheet, 'unrelated sheets are not touched');

const options = equipment.cls.defaultOptions;
assert.deepEqual(options.classes, ['sheet', 'item', 'gurps-item-modern'], 'CSS class is appended once');
assert.equal(options.resizable, true, 'window becomes resizable');
assert.equal(options.width, 760, 'default width is applied');
assert.equal(options.height, 720, 'default height is applied');
assert.equal(options.template, TEMPLATE, 'system template is preserved');
assert.deepEqual(options.tabs, FakeGurpsItemSheet.defaultOptions.tabs, 'system tabs configuration is preserved');

const sheet = Object.create(equipment.cls.prototype);
sheet.position = { width: 912, height: 804 };
sheet._onResize({});
await new Promise(resolve => setTimeout(resolve, 0));

assert.deepEqual(
  settingValues.get('gurps-item-modern.windowSize'),
  { width: 912, height: 804 },
  'window size is stored'
);
assert.equal(equipment.cls.defaultOptions.width, 912, 'stored width is restored through defaultOptions');
assert.equal(equipment.cls.defaultOptions.height, 804, 'stored height is restored through defaultOptions');

// Guard against double-wrapping when the patch runs twice.
const ModernClass = equipment.cls;
for (const handler of readyHandlers) handler();
assert.equal(
  CONFIG.Item.sheetClasses.equipment['gurps.GurpsItemSheet'].cls,
  ModernClass,
  'patch is idempotent'
);

console.log('smoke ok: registry patch, fallback detection, resize options, size persistence, idempotency');

