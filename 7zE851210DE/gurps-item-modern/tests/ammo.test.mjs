/**
 * Ammunition logic tests with minimal Foundry/GURPS mocks.
 * Run: node tests/ammo.test.mjs
 */

import assert from 'node:assert/strict';

/* -------------------------------------------- */
/*  Mock environment                            */
/* -------------------------------------------- */

const state = {
  assistantActive: false,
  settings: {
    autoCreateAmmo: true,
    blockWhenEmpty: true,
    respectExternalAmmo: true,
  },
  warnings: [],
};

function setProperty(object, path, value) {
  const parts = String(path).split('.');
  let target = object;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    if (!target[key] || typeof target[key] !== 'object') target[key] = {};
    target = target[key];
  }
  target[parts[parts.length - 1]] = value;
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return map[character];
  });
}

globalThis.foundry = {
  utils: {
    deepClone: value => structuredClone(value),
    escapeHTML,
  },
  applications: { api: { DialogV2: { prompt: async () => 1 } } },
};

globalThis.game = {
  user: { id: 'user-1', isGM: false },
  actors: { has: () => true },
  modules: {
    get: id => (id === 'gga-ammo-resource-assistant' && state.assistantActive ? { active: true } : null),
  },
  settings: {
    get: (namespace, key) => state.settings[key],
  },
  i18n: {
    localize: key => (key === 'GURPS.combat.rof.numberOfShotsTitle' ? 'Number of shots' : key),
    format: (key, data = {}) => {
      if (key === 'GURPSITEMODERN.Ammo.TrackerName') return `Ammo: ${data.weapon}`;
      if (key === 'GURPS.combat.rof.numberOfShotsLabel') return `Number of shots (1-${data.max}):`;
      if (key === 'GURPSITEMODERN.Ammo.NoAmmo') return 'Кончился боезапас';
      if (key === 'GURPSITEMODERN.Ammo.NotEnough') {
        return `${data.weapon}: only ${data.spent} of ${data.requested} shots were available`;
      }
      if (key === 'GURPSITEMODERN.Ammo.Empty') return `${data.weapon}: no ammunition`;
      return key;
    },
  },
  ui: {
    notifications: {
      warn: message => state.warnings.push(message),
      info: () => {},
    },
  },
};

delete globalThis.GURPS;

const data = await import('../scripts/ammo/data.mjs');
const sync = await import('../scripts/ammo/sync.mjs');
const attackModule = await import('../scripts/ammo/attack.mjs');

/* -------------------------------------------- */
/*  Fixtures                                    */
/* -------------------------------------------- */

function createItem({ id, name, shots = '30+1(3)', rof = '3', actorId = 'actor-1' }) {
  return {
    id,
    name,
    type: 'equipment',
    uuid: `Actor.${actorId}.Item.${id}`,
    system: {
      globalid: `World.${name}`,
      ranged: {
        '00001': { name, mode: '', shots, rof },
      },
    },
  };
}

function createUsesItem({ id, name, count = '100', uses = '6', maxuses = '10', actorId = 'actor-1' }) {
  const item = {
    id,
    name,
    type: 'equipment',
    uuid: `Actor.${actorId}.Item.${id}`,
    system: { eqt: { count, uses, maxuses } },
    async update(updates) {
      for (const [path, value] of Object.entries(updates)) {
        setProperty(item, path, structuredClone(value));
      }
      return item;
    },
  };
  return item;
}

function createActor({ id = 'actor-1', name = 'Actor', items = [] } = {}) {
  const actor = {
    id,
    uuid: `Actor.${id}`,
    name,
    documentName: 'Actor',
    isOwner: true,
    flags: {},
    items: {
      contents: items,
      get: itemId => items.find(item => item.id === itemId) ?? null,
      values: () => items.values(),
    },
    system: {
      additionalresources: {
        tracker: {},
      },
    },
    async update(updates) {
      for (const [path, value] of Object.entries(updates)) {
        setProperty(actor, path, structuredClone(value));
      }
      return actor;
    },
  };
  return actor;
}

function trackerOf(actor, entry) {
  const key = data.resolveTrackerKey(actor, entry);
  return data.getTracker(actor, key);
}

/* -------------------------------------------- */
/*  Ranged skill level repair                   */
/* -------------------------------------------- */

{
  const rifle = createItem({ id: 'rifle-repair', name: 'Repair Rifle', shots: '10(3)', rof: '1' });
  rifle.system.ranged['00001'].import = '10';
  const child = {
    id: 'rifle-repair-atk',
    name: 'Repair Rifle',
    type: 'rangedAtk',
    uuid: 'Actor.actor-1.Item.rifle-repair-atk',
    system: { rng: { import: '', level: 0, name: 'Repair Rifle' } },
  };
  const actor = createActor({ items: [rifle, child] });
  actor.system.ranged = {
    '00001': {
      name: 'Repair Rifle',
      mode: '',
      itemid: child.id,
      fromItem: rifle.id,
      import: undefined,
      level: NaN,
      rof: '1',
      shots: '10(3)',
    },
  };

  const repaired = await sync.repairRangedAttackLevels(actor);
  assert.equal(repaired, true, 'broken import is repaired');
  assert.equal(actor.system.ranged['00001'].import, '10', 'static item level is restored from the parent item');
  assert.equal(actor.system.ranged['00001'].level, 10, 'actor level is restored');
}

{
  const rifle = createItem({ id: 'rifle-otf', name: 'OTF Rifle', shots: '10(3)', rof: '1' });
  rifle.system.ranged['00001'].import = '10';
  rifle.system.ranged['00001'].otf = 'Guns (Rifle)';
  const actor = createActor({ items: [rifle] });
  actor.system.ranged = {
    '00001': {
      name: 'OTF Rifle',
      mode: '',
      fromItem: rifle.id,
      import: undefined,
      level: NaN,
      otf: 'Guns (Rifle)',
      rof: '1',
      shots: '10(3)',
    },
  };

  const repaired = await sync.repairRangedAttackLevels(actor);
  assert.equal(repaired, false, 'OTF-linked attacks are left to the GURPS skill calculation');
  assert.equal(actor.system.ranged['00001'].import, undefined, 'OTF import is not frozen to a static value');
}

/* -------------------------------------------- */
/*  Parsing                                     */
/* -------------------------------------------- */

assert.equal(data.parseShotsCapacity('30+1(3)'), 31, 'Shots with chamber');
assert.equal(data.parseShotsCapacity('30(3)'), 30, 'Shots with reload');
assert.equal(data.parseShotsCapacity('3(3)'), 3, 'small magazine');
assert.equal(data.parseShotsCapacity('1(2)'), 1, 'single shot');
assert.equal(data.parseShotsCapacity('T'), 0, 'thrown has no magazine');
assert.equal(data.parseShotsCapacity(''), 0, 'empty Shots');
assert.equal(data.parseShotsCapacity('0'), 0, 'zero Shots');

assert.equal(data.parseRateOfFire('3x9'), 3, 'shotgun RoF');
assert.equal(data.parseRateOfFire('10'), 10, 'automatic RoF');
assert.equal(data.parseRateOfFire(''), 1, 'empty RoF');

/* -------------------------------------------- */
/*  Tracker creation and idempotency            */
/* -------------------------------------------- */

{
  const rifle = createItem({ id: 'rifle-1', name: 'Rifle' });
  const actor = createActor({ items: [rifle] });
  let updateCount = 0;
  const originalUpdate = actor.update;
  actor.update = async updates => {
    updateCount += 1;
    return originalUpdate(updates);
  };

  const entries = await sync.ensureAmmoTrackers(actor, { create: true, cleanup: true });
  assert.equal(entries.length, 1, 'one ammo entry is created');
  assert.equal(updateCount, 1, 'creation uses one actor update');

  const entry = entries[0];
  assert.equal(entry.sourceId, 'rifle-1', 'mapping uses the embedded item id');
  assert.equal(entry.name, 'Rifle');
  assert.equal(entry.capacity, 31);
  assert.equal(entry.trackerKey, '0000');
  assert.equal(entry.trackerName, 'Ammo: Rifle');
  assert.equal(entry.tracker.value, 31, 'new magazine is full');
  assert.equal(entry.tracker.max, 31);

  await sync.ensureAmmoTrackers(actor, { create: true, cleanup: true });
  assert.equal(updateCount, 1, 'second synchronisation is a no-op');
}

{
  const rifle = createItem({ id: 'rifle-1', name: 'Rifle', shots: '' });
  const actor = createActor({ items: [rifle] });
  const entries = await sync.ensureAmmoTrackers(actor, { create: true, cleanup: true });
  assert.equal(entries.length, 0, 'no Shots means no tracker');
  assert.deepEqual(actor.system.additionalresources.tracker, {}, 'no tracker object was added');
}

{
  const attack = {
    id: 'ranged-attack-1',
    name: 'Direct Ranged Attack',
    type: 'rangedAtk',
    uuid: 'Actor.actor-1.Item.ranged-attack-1',
    system: { rng: { name: 'Direct Ranged Attack', shots: '6(3)', rof: '1' } },
  };
  const actor = createActor({ items: [attack] });
  const entries = await sync.ensureAmmoTrackers(actor, { create: true, cleanup: true });
  assert.equal(entries.length, 1, 'direct rangedAtk items are tracked');
  assert.equal(entries[0].capacity, 6);
}

{
  const rifle = createItem({ id: 'rifle-replace', name: 'Replace Rifle', shots: '5(3)' });
  const actor = createActor({ items: [rifle] });
  const calls = [];
  actor.update = async updates => {
    calls.push(updates);
    return actor;
  };

  const previousRelease = globalThis.game.release;
  const previousReplace = globalThis._replace;
  globalThis.game.release = { generation: 14 };
  globalThis._replace = value => ({ __replace: value });

  try {
    await sync.ensureAmmoTrackers(actor, { create: true, cleanup: true });
    const trackerUpdate = calls.find(update => update['system.additionalresources.tracker']);
    assert.ok(
      trackerUpdate?.['system.additionalresources.tracker']?.__replace,
      'Foundry v14 tracker update uses _replace'
    );
  } finally {
    globalThis.game.release = previousRelease;
    if (previousReplace === undefined) delete globalThis._replace;
    else globalThis._replace = previousReplace;
  }
}

/* -------------------------------------------- */
/*  Per-actor isolation                         */
/* -------------------------------------------- */

{
  const rifleA = createItem({ id: 'rifle-a', name: 'Rifle', actorId: 'actor-a' });
  const rifleB = createItem({ id: 'rifle-b', name: 'Rifle', actorId: 'actor-b' });
  rifleB.system.globalid = rifleA.system.globalid;

  const actorA = createActor({ id: 'actor-a', name: 'A', items: [rifleA] });
  const actorB = createActor({ id: 'actor-b', name: 'B', items: [rifleB] });

  await sync.ensureAmmoTrackers(actorA, { create: true, cleanup: true });
  await sync.ensureAmmoTrackers(actorB, { create: true, cleanup: true });
  assert.equal(Object.keys(actorA.system.additionalresources.tracker).length, 1);
  assert.equal(Object.keys(actorB.system.additionalresources.tracker).length, 1);

  actorB.system.additionalresources.tracker['0000'].value = 12;

  await sync.removeAmmoForItem(actorA, 'rifle-a');
  assert.equal(Object.keys(actorA.system.additionalresources.tracker).length, 0, 'A loses its tracker');
  assert.deepEqual(actorA.flags['gurps-item-modern'].ammo.entries, [], 'A loses its mapping');

  assert.equal(
    Object.keys(actorB.system.additionalresources.tracker).length,
    1,
    'B keeps its own tracker for a copy of the same world item'
  );
  assert.equal(actorB.system.additionalresources.tracker['0000'].value, 12, 'B keeps its own ammo value');
  assert.equal(actorB.flags['gurps-item-modern'].ammo.entries.length, 1, 'B keeps its mapping');
}

/* -------------------------------------------- */
/*  Foundry delete hook (parent may be detached) */
/* -------------------------------------------- */

{
  const rifleA = createItem({ id: 'hook-rifle-a', name: 'Hook Rifle', actorId: 'hook-a' });
  const rifleB = createItem({ id: 'hook-rifle-b', name: 'Hook Rifle', actorId: 'hook-b' });
  rifleB.system.globalid = rifleA.system.globalid;

  const actorA = createActor({ id: 'hook-a', name: 'Hook A', items: [rifleA] });
  const actorB = createActor({ id: 'hook-b', name: 'Hook B', items: [rifleB] });
  rifleA.parent = actorA;
  rifleB.parent = actorB;

  await sync.ensureAmmoTrackers(actorA, { create: true, cleanup: true });
  await sync.ensureAmmoTrackers(actorB, { create: true, cleanup: true });

  const handlers = new Map();
  globalThis.Hooks = {
    on(name, callback) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(callback);
    },
    call(name, ...args) {
      for (const callback of handlers.get(name) ?? []) callback(...args);
    },
  };
  sync.registerAmmoSyncHooks();

  handlers.get('preDeleteItem')[0](rifleA, {}, 'user-1');
  rifleA.parent = null; // simulate Foundry removing the item from its collection
  handlers.get('deleteItem')[0](rifleA, {}, 'user-1');
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(Object.keys(actorA.system.additionalresources.tracker).length, 0, 'delete hook removes A tracker');
  assert.deepEqual(actorA.flags['gurps-item-modern'].ammo.entries, [], 'delete hook removes A mapping');
  assert.equal(Object.keys(actorB.system.additionalresources.tracker).length, 1, 'B copy is untouched');
  assert.equal(
    actorB.system.additionalresources.tracker['0000'].value,
    31,
    'B keeps full ammunition after A deletion'
  );
}

/* -------------------------------------------- */
/*  Item-create scheduling                      */
/* -------------------------------------------- */

{
  const rifle = createItem({ id: 'scheduled-rifle', name: 'Scheduled Rifle', shots: '5(3)' });
  const actor = createActor({ items: [] });
  rifle.parent = actor;

  const handlers = new Map();
  globalThis.Hooks = {
    on(name, callback) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(callback);
    },
    call(name, ...args) {
      for (const callback of handlers.get(name) ?? []) callback(...args);
    },
  };
  sync.registerAmmoSyncHooks();

  actor.items.contents.push(rifle);
  handlers.get('createItem')[0](rifle, {}, 'user-1');
  handlers.get('updateItem')[0](rifle, {}, {}, 'user-1');
  await new Promise(resolve => setTimeout(resolve, 400));

  assert.equal(
    Object.keys(actor.system.additionalresources.tracker).length,
    1,
    'create followed by update still creates the tracker'
  );
  assert.equal(actor.flags['gurps-item-modern'].ammo.entries.length, 1);
}

/* -------------------------------------------- */
/*  Raw ranged attack creation                   */
/* -------------------------------------------- */

{
  const actor = createActor({ items: [] });
  actor.system.ranged = {};

  const handlers = new Map();
  globalThis.Hooks = {
    on(name, callback) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(callback);
    },
    call(name, ...args) {
      for (const callback of handlers.get(name) ?? []) callback(...args);
    },
  };
  sync.registerAmmoSyncHooks();

  handlers.get('preUpdateActor')[0](actor, {}, {}, 'user-1');
  actor.system.ranged['00001'] = {
    name: 'Raw Added Attack',
    mode: '',
    shots: '4(3)',
    rof: '1',
    uuid: 'raw-added-uuid',
  };
  handlers.get('updateActor')[0](actor, { system: { ranged: actor.system.ranged } }, {}, 'user-1');
  await new Promise(resolve => setTimeout(resolve, 250));

  assert.equal(
    Object.keys(actor.system.additionalresources.tracker).length,
    1,
    'adding a raw ranged attack creates its tracker'
  );
  assert.equal(actor.flags['gurps-item-modern'].ammo.entries.length, 1);
}

/* -------------------------------------------- */
/*  Reindexing and unrelated trackers           */
/* -------------------------------------------- */

{
  const rifle1 = createItem({ id: 'rifle-1', name: 'Rifle One', shots: '5(3)' });
  const rifle2 = createItem({ id: 'rifle-2', name: 'Rifle Two', shots: '10(3)' });
  const actor = createActor({ items: [rifle1, rifle2] });

  actor.system.additionalresources.tracker['0000'] = {
    name: 'Energy',
    value: 3,
    min: 0,
    max: 5,
    isMinimumEnforced: true,
    isMaximumEnforced: true,
    thresholds: [],
  };

  await sync.ensureAmmoTrackers(actor, { create: true, cleanup: true });
  assert.equal(Object.keys(actor.system.additionalresources.tracker).length, 3, 'unrelated tracker is preserved');

  await sync.removeAmmoForItem(actor, 'rifle-1');

  const trackers = actor.system.additionalresources.tracker;
  assert.equal(Object.keys(trackers).length, 2, 'only the deleted weapon tracker is gone');
  assert.equal(trackers['0000'].name, 'Energy', 'unrelated tracker stays at its key');
  assert.equal(trackers['0000'].value, 3);
  assert.equal(trackers['0001'].name, 'Ammo: Rifle Two', 'remaining ammo tracker was reindexed');

  const remaining = actor.flags['gurps-item-modern'].ammo.entries;
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].sourceId, 'rifle-2');
  assert.equal(remaining[0].trackerKey, '0001', 'remaining mapping points to the reindexed tracker');
}

{
  const rifle = createItem({ id: 'rifle-explicit', name: 'Explicit Rifle', shots: '5(3)' });
  const actor = createActor({ items: [rifle] });
  await sync.ensureAmmoTrackers(actor, { create: true, cleanup: true });

  const entry = actor.flags['gurps-item-modern'].ammo.entries[0];
  entry.trackerKey = '9999';
  entry.trackerName = 'Missing tracker';

  const removed = await sync.removeAmmoForItem(actor, rifle.id, '0000');
  assert.equal(removed, true, 'delete uses the visible tracker key even when mapping is stale');
  assert.deepEqual(actor.system.additionalresources.tracker, {}, 'the visible tracker is removed');
}

/* -------------------------------------------- */
/*  Capacity changes and manual values          */
/* -------------------------------------------- */

{
  const rifle = createItem({ id: 'rifle-1', name: 'Rifle', shots: '5(3)' });
  const actor = createActor({ items: [rifle] });
  await sync.ensureAmmoTrackers(actor, { create: true, cleanup: true });

  await sync.setAmmoValues(actor, 'rifle-1', { value: 3 });
  assert.equal(trackerOf(actor, actor.flags['gurps-item-modern'].ammo.entries[0]).value, 3);

  await sync.setAmmoValues(actor, 'rifle-1', { value: 3, max: 7, maxOverride: true });
  let entry = actor.flags['gurps-item-modern'].ammo.entries[0];
  assert.equal(trackerOf(actor, entry).max, 7, 'manual maximum is stored');
  assert.equal(entry.maxOverride, true, 'manual maximum is flagged');

  rifle.system.ranged['00001'].shots = '20(3)';
  await sync.ensureAmmoTrackers(actor, { create: true, cleanup: true });
  entry = actor.flags['gurps-item-modern'].ammo.entries[0];
  assert.equal(trackerOf(actor, entry).max, 7, 'manual maximum survives a Shots change');
  assert.equal(entry.capacity, 20, 'source capacity is updated');
}

{
  const rifle = createItem({ id: 'rifle-1', name: 'Rifle', shots: '30(3)' });
  const actor = createActor({ items: [rifle] });
  await sync.ensureAmmoTrackers(actor, { create: true, cleanup: true });

  rifle.system.ranged['00001'].shots = '10(3)';
  await sync.ensureAmmoTrackers(actor, { create: true, cleanup: true });
  let entry = actor.flags['gurps-item-modern'].ammo.entries[0];
  assert.equal(trackerOf(actor, entry).max, 10, 'maximum follows Shots when not overridden');
  assert.equal(trackerOf(actor, entry).value, 10, 'current value is clamped to the new maximum');

  rifle.system.ranged['00001'].shots = '';
  await sync.ensureAmmoTrackers(actor, { create: true, cleanup: true });
  assert.equal(Object.keys(actor.system.additionalresources.tracker).length, 0, 'empty Shots removes the tracker');
  assert.deepEqual(actor.flags['gurps-item-modern'].ammo.entries, [], 'empty Shots removes the mapping');
}

/* -------------------------------------------- */
/*  Spending                                    */
/* -------------------------------------------- */

{
  const rifle = createItem({ id: 'rifle-1', name: 'Rifle', shots: '5(3)' });
  const actor = createActor({ items: [rifle] });
  await sync.ensureAmmoTrackers(actor, { create: true, cleanup: true });

  let result = await sync.spendAmmo(actor, 'rifle-1', 2);
  assert.deepEqual(result, { spent: 2, value: 3, max: 5 });
  result = await sync.spendAmmo(actor, 'rifle-1', 10);
  assert.equal(result.spent, 3, 'cannot spend more than available');
  assert.equal(result.value, 0);
  result = await sync.spendAmmo(actor, 'rifle-1', 1);
  assert.equal(result.spent, 0, 'empty tracker spends nothing');
}

/* -------------------------------------------- */
/*  Ammo type, linked uses and orphan trackers  */
/* -------------------------------------------- */

{
  const rifle = createItem({ id: 'linked-rifle', name: 'Linked Rifle', shots: '10(3)' });
  const ammoBox = createUsesItem({ id: 'ammo-box', name: 'Ammo Box', count: 12, uses: '6', maxuses: '10' });
  const actor = createActor({ items: [rifle, ammoBox] });

  await sync.ensureAmmoTrackers(actor, { create: true, cleanup: true });
  const typeResult = await sync.setAmmoType(actor, rifle.id, 'AP');
  assert.equal(typeResult.ammoType, 'AP', 'ammo type is stored');

  const linkResult = await sync.setAmmoLink(actor, rifle.id, ammoBox.id);
  assert.equal(linkResult.linkedItemId, ammoBox.id, 'reserve item id is stored');
  assert.equal(linkResult.reserve, 12, 'linked reserve count is available');

  const entries = await sync.ensureAmmoTrackers(actor, { create: true, cleanup: true });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].linked, true, 'entry has a linked reserve');
  assert.equal(entries[0].value, 10, 'magazine value is not overridden by the reserve');
  assert.equal(entries[0].max, 10);
  assert.equal(entries[0].ammoType, 'AP');

  const values = await sync.setAmmoValues(actor, rifle.id, { value: 4 });
  assert.deepEqual(values, { value: 4, max: 10 }, 'magazine values are saved');
  assert.equal(ammoBox.system.eqt.count, 12, 'editing the magazine does not change the reserve');

  const spent = await sync.spendAmmo(actor, rifle.id, 3);
  assert.deepEqual(spent, { spent: 3, value: 1, max: 10 }, 'magazine ammo is spent');
  assert.equal(ammoBox.system.eqt.count, 12, 'attacks do not spend from the reserve');

  const reloaded = await sync.reloadAmmo(actor, rifle.id);
  assert.deepEqual(reloaded, { reloaded: 9, value: 10, max: 10, reserve: 3 }, 'reload fills the magazine');
  assert.equal(ammoBox.system.eqt.count, 3, 'reload subtracts rounds from the reserve');

  await sync.setAmmoValues(actor, rifle.id, { value: 0 });
  const partial = await sync.reloadAmmo(actor, rifle.id);
  assert.deepEqual(partial, { reloaded: 3, value: 3, max: 10, reserve: 0 }, 'partial reload uses the remaining reserve');
  assert.equal(ammoBox.system.eqt.count, 0);

  const empty = await sync.reloadAmmo(actor, rifle.id);
  assert.equal(empty.reloaded, 0, 'empty reserve cannot reload');

  const removed = await sync.removeAmmoForItem(actor, rifle.id);
  assert.equal(removed, true, 'mapping and tracker are removed');
  assert.equal(actor.flags['gurps-item-modern'].ammo.entries.length, 0);
  assert.ok(actor.items.get(ammoBox.id), 'linked reserve item is not deleted');
}

{
  const actor = createActor({ items: [] });
  actor.system.additionalresources.tracker['0000'] = {
    name: 'Ammo: Stale Rifle',
    value: 5,
    min: 0,
    max: 10,
    isMinimumEnforced: true,
    isMaximumEnforced: true,
    thresholds: [],
  };

  const entries = data.getActorAmmoEntries(actor);
  assert.equal(entries.length, 1, 'stale ammo tracker is shown in the panel');
  assert.equal(entries[0].orphan, true, 'stale tracker is marked as orphan');
  assert.equal(entries[0].trackerKey, '0000');

  const removed = await sync.removeAmmoTracker(actor, '0000');
  assert.equal(removed, true, 'orphan tracker can be deleted');
  assert.deepEqual(actor.system.additionalresources.tracker, {}, 'orphan tracker is gone');
}

{
  const actor = createActor({ items: [] });
  await sync.ensureAmmoTrackers(actor, { create: true, cleanup: true, markInitialized: true });
  assert.equal(actor.flags['gurps-item-modern'].ammoInitialized, true, 'first automatic setup is marked');
}

{
  const actor = createActor({ items: [] });
  actor.system.additionalresources.tracker['0000'] = {
    name: 'Ammo: Stale One',
    value: 5,
    min: 0,
    max: 10,
    isMinimumEnforced: true,
    isMaximumEnforced: true,
    thresholds: [],
  };
  actor.system.additionalresources.tracker['0001'] = {
    name: 'Ammo: Stale Two',
    value: 4,
    min: 0,
    max: 8,
    isMinimumEnforced: true,
    isMaximumEnforced: true,
    thresholds: [],
  };

  const removed = await sync.removeOrphanAmmoTrackers(actor);
  assert.equal(removed, true, 'bulk cleanup removes all orphan trackers');
  assert.deepEqual(actor.system.additionalresources.tracker, {}, 'orphan trackers are gone');
}

{
  const rifle = createItem({ id: 'rifle-suppressed', name: 'Suppressed Rifle', shots: '5(3)' });
  const actor = createActor({ items: [rifle] });
  await sync.ensureAmmoTrackers(actor, { create: true, cleanup: true });
  await sync.removeAmmoForItem(actor, rifle.id, '0000');

  assert.equal(actor.flags['gurps-item-modern'].ammoSuppressed.includes(rifle.id), true);
  await sync.ensureAmmoTrackers(actor, { create: true, cleanup: true });
  assert.deepEqual(actor.system.additionalresources.tracker, {}, 'deleted tracker is not recreated');

  await sync.ensureAmmoTrackers(actor, { create: true, cleanup: true, clearSuppression: true });
  assert.equal(Object.keys(actor.system.additionalresources.tracker).length, 1, 'sync can recreate it');
}

/* -------------------------------------------- */
/*  Attack wrapper                              */
/* -------------------------------------------- */

async function runAttack({
  shots = '5(3)',
  rof = '3',
  promptResult = 2,
  promptError = false,
  assistant = false,
  autoCreate = true,
  empty = false,
  linkedUses = null,
  rawAttack = false,
  event = { preventDefault() {} },
} = {}) {
  state.assistantActive = assistant;
  state.settings.autoCreateAmmo = autoCreate;

  const item = rawAttack ? null : createItem({ id: 'rifle-attack', name: 'Rifle', shots, rof });
  const actor = createActor({ id: 'actor-attack', items: item ? [item] : [] });
  if (rawAttack) {
    actor.system.ranged = {
      '00001': { name: 'Raw Rifle', mode: '', shots, rof, uuid: 'raw-attack-uuid' },
    };
  }
  if (autoCreate) await sync.ensureAmmoTrackers(actor, { create: true, cleanup: true });

  const mappedSourceId = rawAttack
    ? actor.flags['gurps-item-modern']?.ammo?.entries?.[0]?.sourceId
    : item.id;

  let linkedItem = null;
  if (linkedUses !== null) {
    linkedItem = createUsesItem({
      id: 'ammo-attack',
      name: 'Ammo',
      count: String(linkedUses),
      maxuses: '10',
      actorId: actor.id,
    });
    actor.items.contents.push(linkedItem);
    await sync.setAmmoLink(actor, mappedSourceId, linkedItem.id);
  }

  if (empty && actor.flags['gurps-item-modern']?.ammo?.entries?.length) {
    await sync.setAmmoValues(actor, mappedSourceId, { value: 0 });
  }

  const attack = rawAttack
    ? actor.system.ranged['00001']
    : {
        name: 'Rifle',
        mode: '',
        itemid: item.id,
        fromItem: item.id,
        rof,
        shots,
      };

  let originalCalls = 0;
  let promptOptions = null;
  const originalPrompt = async options => {
    promptOptions = options;
    if (promptError) throw new Error('cancelled');
    return promptResult;
  };
  foundry.applications.api.DialogV2.prompt = originalPrompt;

  const GURPS = {
    lastTargetedRoll: null,
    actionFuncs: {
      attack: async () => {
        originalCalls += 1;
        const currentRof = data.parseRateOfFire(attack.rof);
        if (currentRof > 1) {
          await foundry.applications.api.DialogV2.prompt({
            window: { title: 'Number of shots' },
            content: `<input id="get-number-input" name="number" type="number" min="1" max="${currentRof}" value="${currentRof}">`,
          });
        }
        GURPS.setLastTargetedRoll({ thing: attack.name, chatthing: `[@${actor.id}@R:${attack.name}]` }, actor.id);
        return true;
      },
    },
    findAttack: () => attack,
    setLastTargetedRoll: function (chatdata) {
      this.lastTargetedRoll = chatdata;
    },
  };
  globalThis.GURPS = GURPS;
  attackModule.registerAmmoAttackHook();

  const result = await GURPS.actionFuncs.attack({
    action: { type: 'attack', name: attack.name, isMelee: false, isRanged: true },
    actor,
    event,
  });

  return {
    actor,
    item,
    linkedItem,
    attack,
    result,
    originalCalls: () => originalCalls,
    promptOptions: () => promptOptions,
  };
}

{
  const run = await runAttack({ shots: '5(3)', rof: '3', promptResult: 3 });
  assert.equal(run.result, true);
  assert.equal(run.originalCalls(), 1);
  assert.match(run.promptOptions().content, /value="1"/, 'shot prompt defaults to one shot');
  const entry = run.actor.flags['gurps-item-modern'].ammo.entries[0];
  assert.equal(trackerOf(run.actor, entry).value, 2, 'three shots are spent');
}

{
  const run = await runAttack({ shots: '5(3)', rof: '1', promptResult: 3 });
  assert.equal(run.promptOptions(), null, 'single-shot attack does not prompt');
  const entry = run.actor.flags['gurps-item-modern'].ammo.entries[0];
  assert.equal(trackerOf(run.actor, entry).value, 4, 'RoF 1 spends one shot');
}

{
  const run = await runAttack({ shots: '5(3)', rof: '1', linkedUses: 4 });
  assert.equal(run.originalCalls(), 1, 'linked-reserve attack runs');
  assert.equal(Number(run.linkedItem.system.eqt.count), 4, 'attack does not spend from the reserve');
  const entry = run.actor.flags['gurps-item-modern'].ammo.entries[0];
  assert.equal(trackerOf(run.actor, entry).value, 4, 'magazine is spent');
}

{
  const run = await runAttack({ rawAttack: true, shots: '4(3)', rof: '1' });
  assert.equal(run.originalCalls(), 1, 'raw ranged attack runs');
  const entry = run.actor.flags['gurps-item-modern'].ammo.entries[0];
  assert.equal(trackerOf(run.actor, entry).value, 3, 'raw ranged attack spends ammunition');
}

{
  const run = await runAttack({ shots: '2(3)', rof: '3', promptResult: 2 });
  const entry = run.actor.flags['gurps-item-modern'].ammo.entries[0];
  assert.equal(trackerOf(run.actor, entry).value, 0, 'only available shots are spent');
  assert.match(run.promptOptions().content, /max="2"/, 'prompt is limited to available ammunition');
  assert.match(run.promptOptions().content, /value="1"/, 'prompt defaults to one shot');
}

{
  const run = await runAttack({ shots: '5(3)', rof: '3', promptError: true });
  const entry = run.actor.flags['gurps-item-modern'].ammo.entries[0];
  assert.equal(trackerOf(run.actor, entry).value, 4, 'canceled prompt falls back to one shot');
}

{
  state.warnings = [];
  const run = await runAttack({ shots: '5(3)', rof: '3', empty: true });
  assert.equal(run.result, false, 'empty attack is blocked');
  assert.equal(run.originalCalls(), 0, 'GURPS attack is not executed');
  assert.ok(state.warnings.includes('Кончился боезапас'), 'the requested out-of-ammo hint is shown');
}

{
  const run = await runAttack({ shots: '5(3)', rof: '3', assistant: true, event: { shiftKey: false, data: {} } });
  assert.equal(run.originalCalls(), 1, 'external workflow attack still runs');
  const entry = run.actor.flags['gurps-item-modern'].ammo.entries[0];
  assert.equal(trackerOf(run.actor, entry).value, 5, 'external workflow does not double-spend');
}

{
  const run = await runAttack({ shots: '', rof: '3', autoCreate: true });
  assert.equal(run.originalCalls(), 1);
  assert.equal(run.actor.flags['gurps-item-modern'], undefined, 'no Shots means no mapping and no spend');
}

console.log(
  'ammo ok: parsing, per-actor isolation, deletion, reindexing, capacity, ranged level repair, ammo type, linked reserve, orphan trackers, spending, attack wrapper'
);



