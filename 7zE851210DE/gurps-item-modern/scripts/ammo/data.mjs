/**
 * Ammo data helpers.
 *
 * Locale independence: the magazine capacity is always read from the GURPS data key
 * `system.ranged.<key>.shots` (English UI "Shots", Russian UI "Бзс"). No localized
 * label is ever used to identify the field.
 *
 * Actor isolation: every tracker is owned by one actor. The mapping key is the
 * embedded Item id of that actor, never a world Item id / `system.globalid`.
 */

export const MODULE_ID = 'gurps-item-modern';
export const AMMO_FLAG = 'ammo';
export const AMMO_INITIALIZED_FLAG = 'ammoInitialized';
export const AMMO_SUPPRESSED_FLAG = 'ammoSuppressed';
export const AMMO_VERSION = 1;
export const TRACKER_ROOT_PATH = 'system.additionalresources.tracker';
export const TRACKER_NAME_KEY = 'GURPSITEMODERN.Ammo.TrackerName';

export function getGame() {
  return globalThis.game;
}

export function padTrackerKey(index) {
  return String(index).padStart(4, '0');
}

export function toInt(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

export function clampInt(value, min, max) {
  const number = toInt(value, min);
  return Math.min(Math.max(number, min), max);
}

/**
 * Parse the GURPS Shots (Бзс) field.
 * Supported examples: "30+1(3)" => 31, "30(3)" => 30, "3(3)" => 3,
 * "1(2)" => 1, "T" / "" / "0" => 0.
 * @param {unknown} value
 * @returns {number}
 */
export function parseShotsCapacity(value) {
  if (typeof value === 'number') return Math.max(0, Math.trunc(value));
  const text = String(value ?? '').trim();
  if (!text) return 0;
  const match = text.match(/^(\d+)(?:\s*\+\s*(\d+))?/);
  if (!match) return 0;
  return (Number.parseInt(match[1], 10) || 0) + (Number.parseInt(match[2], 10) || 0);
}

/**
 * Parse the GURPS RoF (Сс) field. Shotgun notation ("3x9") yields 3.
 * @param {unknown} value
 * @returns {number}
 */
export function parseRateOfFire(value) {
  const match = String(value ?? '').match(/^\s*(\d+)/);
  const number = Number.parseInt(match?.[1] ?? '1', 10);
  return Number.isFinite(number) && number > 0 ? number : 1;
}

export function normalizeText(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

export function getAmmoData(actor) {
  const raw = actor?.flags?.[MODULE_ID]?.[AMMO_FLAG];
  const entries = Array.isArray(raw?.entries) ? raw.entries : [];
  return {
    version: AMMO_VERSION,
    entries: entries
      .filter(entry => entry && typeof entry === 'object' && typeof entry.sourceId === 'string' && entry.sourceId)
      .map(entry => ({ ...entry })),
  };
}

export function getAmmoFlagObject(entries) {
  return {
    version: AMMO_VERSION,
    entries: Array.isArray(entries) ? entries.map(entry => ({ ...entry })) : [],
  };
}

/**
 * Whether this actor already had its one-time automatic ammunition setup.
 * It prevents a manually deleted tracker from being recreated on every render.
 * @param {Actor} actor
 * @returns {boolean}
 */
export function isAmmoInitialized(actor) {
  return !!actor?.flags?.[MODULE_ID]?.[AMMO_INITIALIZED_FLAG];
}

export function getTrackerRoot(actor) {
  return actor?.system?.additionalresources?.tracker ?? {};
}

export function getTrackerKeys(root) {
  return Object.keys(root ?? {}).sort();
}

export function getTracker(actor, key) {
  if (!key) return null;
  return actor?.system?.additionalresources?.tracker?.[key] ?? null;
}

export function getTrackerValue(actor, key) {
  return toInt(getTracker(actor, key)?.value, 0);
}

export function getTrackerMax(actor, key) {
  return toInt(getTracker(actor, key)?.max, 0);
}

/**
 * Resolve a mapping entry to a live tracker key. The stored key is preferred,
 * the tracker name is a fallback after the user removes/reindexes trackers.
 * @returns {string|null}
 */
export function resolveTrackerKey(actor, entry) {
  if (!entry) return null;
  const root = getTrackerRoot(actor);
  const stored = entry.trackerKey;
  if (stored && root[stored]) {
    const storedName = String(root[stored]?.name ?? '');
    const expected = String(entry.trackerName ?? '');
    if (!expected || storedName === expected) return stored;
  }

  const expected = String(entry.trackerName ?? '').trim();
  if (!expected) return stored && root[stored] ? stored : null;

  const matches = Object.keys(root).filter(key => String(root[key]?.name ?? '') === expected);
  return matches.length === 1 ? matches[0] : null;
}

export function buildTrackerName(itemName) {
  const weapon = String(itemName ?? '').trim() || 'Weapon';
  const key = TRACKER_NAME_KEY;
  let localized = key;
  try {
    localized = getGame()?.i18n?.format?.(key, { weapon }) ?? key;
  } catch (err) {
    localized = key;
  }
  return localized && localized !== key ? localized : `Ammo: ${weapon}`;
}

/**
 * Whether a resource tracker looks like an ammunition tracker created by this
 * module (also recognises stale trackers from older module versions).
 * @param {string} name
 * @returns {boolean}
 */
export function isAmmoTrackerName(name) {
  const value = String(name ?? '').trim();
  if (!value) return false;

  const prefixes = ['Ammo:', 'Боезапас:'];
  try {
    const marker = '\u0000';
    const formatted = getGame()?.i18n?.format?.(TRACKER_NAME_KEY, { weapon: marker });
    if (formatted && formatted !== TRACKER_NAME_KEY) {
      const index = formatted.indexOf(marker);
      if (index >= 0) prefixes.push(formatted.slice(0, index));
    }
  } catch (err) {
    /* ignore */
  }

  return prefixes.some(prefix => prefix && value.startsWith(prefix));
}

export function uniqueTrackerName(actor, baseName, ignoreKey = null) {
  const used = new Set(
    Object.entries(getTrackerRoot(actor))
      .filter(([key]) => key !== ignoreKey)
      .map(([, tracker]) => String(tracker?.name ?? '').trim())
      .filter(Boolean)
  );
  const base = String(baseName ?? '').trim() || 'Ammo';
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base} (${index})`)) index += 1;
  return `${base} (${index})`;
}

/* -------------------------------------------- */
/*  Item / attack helpers                       */
/* -------------------------------------------- */

export function getActorItems(actor) {
  const collection = actor?.items;
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (typeof collection.values === 'function') return Array.from(collection.values());
  if (Array.isArray(collection.contents)) return collection.contents;
  return [];
}

export function getItemById(actor, itemId) {
  const id = String(itemId ?? '');
  if (!id) return null;
  const collection = actor?.items;
  if (typeof collection?.get === 'function') return collection.get(id) ?? null;
  return getActorItems(actor).find(item => item?.id === id) ?? null;
}

/**
 * Read the GURPS equipment uses counter (`system.eqt.uses` / `maxuses`).
 * @param {Item|null} item
 * @returns {{value:number, max:number}|null}
 */
/**
 * Raw ranged attack components stored directly on the actor (the “+ Ranged”
 * button in the Combat tab). These have no embedded Foundry Item.
 * @param {Actor} actor
 * @returns {{attack:object,key:string,path:string,uuid:string}[]}
 */
export function getRawRangedAttacks(actor) {
  const result = [];
  const visit = (object, path) => {
    if (!object || typeof object !== 'object') return;
    for (const [key, value] of Object.entries(object)) {
      if (!value || typeof value !== 'object') continue;
      const childPath = path ? `${path}.${key}` : key;
      if (
        ('shots' in value || 'rof' in value) &&
        !value.itemid &&
        !value.fromItem
      ) {
        result.push({ attack: value, key, path: childPath, uuid: String(value.uuid ?? '') });
      }
      if (value.contains) visit(value.contains, `${childPath}.contains`);
    }
  };
  visit(actor?.system?.ranged, 'ranged');
  return result;
}

export function getRawAttackSourceId(raw) {
  return `raw:${String(raw?.uuid || raw?.path || '')}`;
}

export function getRawAmmoInfo(raw) {
  const shots = String(raw?.attack?.shots ?? '');
  const capacity = parseShotsCapacity(shots);
  return capacity > 0 ? { capacity, shots, attacks: [raw.attack] } : null;
}

export function findRawAmmoEntryForAttack(actor, attack) {
  if (!attack) return null;
  const raw = getRawRangedAttacks(actor).find(
    entry =>
      entry.attack === attack ||
      (!!entry.uuid && String(entry.uuid) === String(attack.uuid ?? '')) ||
      (String(entry.attack.name ?? '') === String(attack.name ?? '') &&
        String(entry.attack.mode ?? '') === String(attack.mode ?? ''))
  );
  if (!raw) return null;

  const sourceId = getRawAttackSourceId(raw);
  return (
    getAmmoData(actor).entries.find(
      entry =>
        String(entry.sourceId) === sourceId ||
        String(entry.rawKey ?? '') === raw.path ||
        (!!raw.uuid && String(entry.rawUuid ?? '') === String(raw.uuid))
    ) ?? null
  );
}

/**
 * All sources which currently have a Shots value and therefore should have an
 * ammunition tracker (embedded items plus raw ranged components).
 * @param {Actor} actor
 * @returns {Set<string>}
 */
export function getAmmoSourceIds(actor) {
  const sourceIds = new Set();
  for (const item of getActorItems(actor)) {
    if (!item || (item.type !== 'equipment' && item.type !== 'rangedAtk')) continue;
    if (getItemAmmoInfo(item)) sourceIds.add(String(item.id));
  }
  for (const raw of getRawRangedAttacks(actor)) {
    if (getRawAmmoInfo(raw)) sourceIds.add(getRawAttackSourceId(raw));
  }
  return sourceIds;
}

/**
 * Sources explicitly deleted by the user; the automatic setup must not recreate
 * their trackers until the user presses the synchronise button.
 * @param {Actor} actor
 * @returns {string[]}
 */
export function getSuppressedAmmoSources(actor) {
  const raw = actor?.flags?.[MODULE_ID]?.[AMMO_SUPPRESSED_FLAG];
  if (!Array.isArray(raw)) return [];
  return raw.map(value => String(value ?? '').trim()).filter(Boolean);
}

export function getItemUses(item) {
  const eqt = item?.system?.eqt;
  if (!eqt) return null;
  const value = Math.max(0, toInt(eqt.uses, 0));
  const maxuses = Math.max(0, toInt(eqt.maxuses, 0));
  return { value, max: maxuses > 0 ? maxuses : value };
}

/**
 * Quantity of an ammunition reserve item (`system.eqt.count`).
 * @param {Item|null} item
 * @returns {number}
 */
export function getItemCount(item) {
  const eqt = item?.system?.eqt;
  if (!eqt) return 0;
  return Math.max(0, toInt(eqt.count, 0));
}

/**
 * Resolve the optional embedded item whose uses counter supplies ammunition.
 * @param {Actor} actor
 * @param {object} entry
 * @returns {Item|null}
 */
export function getLinkedAmmoItem(actor, entry) {
  const linkedId = String(entry?.linkedItemId ?? '');
  if (!linkedId) return null;

  let item = getItemById(actor, linkedId);
  if (!item && linkedId.includes('.')) item = getItemById(actor, linkedId.split('.').pop());
  if (!item || !item.system?.eqt) return null;
  return item;
}

/**
 * Resolve current/max ammunition for one mapping entry, preferring a linked
 * item's uses counter and falling back to the actor's resource tracker.
 * @param {Actor} actor
 * @param {object} entry
 * @returns {{linked:boolean, linkedItem:Item|null, trackerKey:string|null, tracker:object|null, value:number, max:number}}
 */
export function getAmmoEntryState(actor, entry) {
  const linkedItem = getLinkedAmmoItem(actor, entry);
  const trackerKey = resolveTrackerKey(actor, entry);
  const tracker = getTracker(actor, trackerKey);
  return {
    linked: !!linkedItem,
    linkedItem,
    trackerKey,
    tracker,
    value: toInt(tracker?.value, 0),
    max: toInt(tracker?.max, entry?.capacity ?? 0),
  };
}

export function getRangedAttacksFromItem(item) {
  const attacks = [];
  const visit = (object, path) => {
    if (!object || typeof object !== 'object') return;
    for (const [key, value] of Object.entries(object)) {
      if (!value || typeof value !== 'object') continue;
      const childPath = path ? `${path}.${key}` : key;
      if ('shots' in value || 'rof' in value) {
        attacks.push({ ...value, key, path: childPath });
      }
      if (value.contains) visit(value.contains, `${childPath}.contains`);
    }
  };

  if (item?.system?.ranged && typeof item.system.ranged === 'object' && Object.keys(item.system.ranged).length) {
    visit(item.system.ranged, 'ranged');
  } else if (item?.system?.rng && typeof item.system.rng === 'object') {
    visit({ rng: item.system.rng }, 'ranged');
  }
  return attacks;
}

/**
 * @param {Item|null} item
 * @returns {{capacity:number, shots:string, attacks:object[]}|null}
 */
export function getItemAmmoInfo(item) {
  if (!item) return null;
  // A rangedAtk child created from an equipment item is already covered by its
  // parent equipment item; do not create a second tracker for it.
  if (item.type === 'rangedAtk' && item.system?.fromItem) return null;

  const attacks = getRangedAttacksFromItem(item);
  if (!attacks.length) return null;

  let capacity = 0;
  let shots = '';
  for (const attack of attacks) {
    const parsed = parseShotsCapacity(attack.shots);
    if (parsed > capacity) {
      capacity = parsed;
      shots = String(attack.shots ?? '');
    }
  }

  return capacity > 0 ? { capacity, shots, attacks } : null;
}

/**
 * Extract the embedded item id from an actor ranged attack.
 * @param {object} attack
 * @returns {string}
 */
export function getAttackItemId(attack) {
  return String(attack?.itemid || attack?.fromItem || '');
}

/**
 * Find the actor-local item that owns a ranged attack. Never uses world ids.
 * @param {Actor} actor
 * @param {object} attack
 * @returns {Item|null}
 */
export function findAmmoItemForAttack(actor, attack) {
  const directId = getAttackItemId(attack);
  let direct = getItemById(actor, directId);
  if (!direct && directId.includes('.')) {
    // Some system versions put an Item UUID into itemid/fromItem.
    direct = getItemById(actor, directId.split('.').pop());
  }
  if (direct && getItemAmmoInfo(direct)) return direct;

  const attackUuid = String(attack?.uuid ?? '');
  const attackName = normalizeText(attack?.name);
  const attackMode = normalizeText(attack?.mode);

  for (const item of getActorItems(actor)) {
    if (!item || (item.type !== 'equipment' && item.type !== 'rangedAtk')) continue;
    const info = getItemAmmoInfo(item);
    if (!info) continue;
    if (attackUuid && info.attacks.some(entry => String(entry.uuid ?? '') === attackUuid)) return item;
    if (
      !attackUuid &&
      attackName &&
      info.attacks.some(
        entry => normalizeText(entry.name) === attackName && normalizeText(entry.mode) === attackMode
      )
    ) {
      return item;
    }
  }

  return null;
}

/**
 * Return current ammo rows for the actor, sorted for the combat panel.
 * Trackers that no longer exist are omitted.
 */
export function getActorAmmoEntries(actor) {
  const rows = getAmmoData(actor)
    .entries.map(entry => {
      const state = getAmmoEntryState(actor, entry);
      if (!state.tracker) return null;
      return {
        ...entry,
        ...state,
        value: state.value,
        max: state.max,
        linkedItemName: String(state.linkedItem?.name ?? ''),
        ammoType: String(entry.ammoType ?? ''),
        linkedItemId: String(entry.linkedItemId ?? ''),
      };
    })
    .filter(Boolean);

  const referenced = new Set(
    getAmmoData(actor)
      .entries.map(entry => String(entry.trackerKey ?? ''))
      .filter(Boolean)
  );
  for (const key of getTrackerKeys(getTrackerRoot(actor))) {
    if (referenced.has(key)) continue;
    const tracker = getTracker(actor, key);
    if (!isAmmoTrackerName(tracker?.name)) continue;
    rows.push({
      sourceId: `__orphan__:${key}`,
      name: String(tracker?.name ?? ''),
      trackerName: String(tracker?.name ?? ''),
      trackerKey: key,
      tracker,
      value: toInt(tracker?.value, 0),
      max: toInt(tracker?.max, 0),
      capacity: toInt(tracker?.max, 0),
      ammoType: '',
      linkedItemId: '',
      linkedItem: null,
      linked: false,
      orphan: true,
    });
  }

  return rows.sort((left, right) => String(left.name ?? '').localeCompare(String(right.name ?? '')));
}

