/**
 * Tracker synchronisation and spending.
 *
 * Everything here is scoped to one actor:
 *  - the mapping key is the embedded Item id of that actor;
 *  - trackers live in that actor's `system.additionalresources.tracker`;
 *  - deleting a weapon on actor A never touches actor B, even when both
 *    actors hold copies of the same world item.
 */

import {
  AMMO_FLAG,
  AMMO_INITIALIZED_FLAG,
  AMMO_SUPPRESSED_FLAG,
  MODULE_ID,
  buildTrackerName,
  clampInt,
  getActorAmmoEntries,
  getActorItems,
  getAmmoData,
  getAmmoFlagObject,
  getGame,
  getItemAmmoInfo,
  getItemById,
  getItemCount,
  getLinkedAmmoItem,
  getRawAmmoInfo,
  getRawAttackSourceId,
  getRawRangedAttacks,
  getRangedAttacksFromItem,
  getSuppressedAmmoSources,
  getTracker,
  getTrackerKeys,
  getTrackerRoot,
  isAmmoInitialized,
  isAmmoTrackerName,
  padTrackerKey,
  resolveTrackerKey,
  toInt,
} from './data.mjs';

const locks = new WeakMap();
const timers = new WeakMap();
const knownRawAttacks = new WeakMap();
const pendingDeletedActors = new Map();
const pendingDeletedDocs = new WeakMap();

function clone(value) {
  if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

const TRACKER_PATH = 'system.additionalresources.tracker';

/**
 * Update an actor while replacing the tracker object instead of merging it.
 * Foundry v14 uses `_replace`; v13 needs a separate delete update. Without this,
 * removed tracker keys survive the update and reappear in the sheet.
 */
async function commitAmmoUpdate(actor, updates, finalRoot) {
  const generation = globalThis.game?.release?.generation;
  if (generation === 13) {
    await actor.update({ 'system.additionalresources.-=tracker': null });
    const payload = { ...updates };
    if (finalRoot !== undefined) payload[TRACKER_PATH] = finalRoot;
    await actor.update(payload);
    return;
  }

  const payload = { ...updates };
  if (finalRoot !== undefined) {
    payload[TRACKER_PATH] =
      typeof globalThis._replace === 'function' ? globalThis._replace(finalRoot) : finalRoot;
  }
  await actor.update(payload);
}

export function canManageActor(actor) {
  return !!actor && (!!actor.isOwner || !!getGame()?.user?.isGM);
}

export function getModuleSetting(key, fallback) {
  try {
    const value = getGame()?.settings?.get?.(MODULE_ID, key);
    return value === undefined ? fallback : value;
  } catch (err) {
    return fallback;
  }
}

export function notify(level, message) {
  const notifications = getGame()?.ui?.notifications;
  if (!notifications?.[level]) return;
  notifications[level](message);
}

export function localize(key, data, fallback) {
  try {
    const value = getGame()?.i18n?.format?.(key, data);
    if (value && value !== key) return value;
  } catch (err) {
    /* ignore */
  }
  return fallback;
}

function normalizeTracker(tracker, name, capacity) {
  const result = { ...(tracker ?? {}) };
  result.name = String(result.name ?? name ?? '').trim();
  result.alias = result.alias ?? '';
  result.pdf = result.pdf ?? '';
  result.min = Number.isFinite(Number(result.min)) ? toInt(result.min, 0) : 0;

  const hasMax =
    result.max !== '' && result.max !== null && result.max !== undefined && Number.isFinite(Number(result.max));
  result.max = hasMax ? toInt(result.max, 0) : toInt(capacity, 0);

  const hasValue =
    result.value !== '' && result.value !== null && result.value !== undefined && Number.isFinite(Number(result.value));
  result.value = hasValue ? toInt(result.value, 0) : result.max;
  if (result.value > result.max) result.value = result.max;
  if (result.value < result.min) result.value = result.min;

  result.points = toInt(result.points, 0);
  result.isDamageTracker = !!result.isDamageTracker;
  result.isDamageType = !!result.isDamageType;
  result.isMinimumEnforced = result.isMinimumEnforced !== false;
  result.isMaximumEnforced = result.isMaximumEnforced !== false;
  result.initialValue = result.initialValue ?? '';
  result.thresholds = Array.isArray(result.thresholds) ? result.thresholds : [];
  result.breakpoints = result.breakpoints !== false;
  return result;
}

function trackerArray(root) {
  return getTrackerKeys(root).map(key => clone(root[key]));
}

function buildTrackerRoot(trackers) {
  const root = {};
  trackers.forEach((tracker, index) => {
    const key = padTrackerKey(index);
    root[key] = { ...tracker, key };
  });
  return root;
}

function trackerIndexForEntry(entry, trackers, keyToIndex, nameToIndex) {
  if (!entry) return -1;

  const expectedName = String(entry.trackerName ?? '').trim();
  if (expectedName) {
    const candidates = nameToIndex.get(expectedName) ?? [];
    if (candidates.length === 1) return candidates[0];
  }
  if (entry.trackerKey && keyToIndex.has(String(entry.trackerKey))) {
    return keyToIndex.get(String(entry.trackerKey));
  }
  return -1;
}

function nextUniqueTrackerName(trackers, baseName) {
  const used = new Set(trackers.map(tracker => String(tracker?.name ?? '').trim()).filter(Boolean));
  if (!used.has(baseName)) return baseName;
  let index = 2;
  while (used.has(`${baseName} (${index})`)) index += 1;
  return `${baseName} (${index})`;
}

function findRangedSource(entry, item) {
  if (!item) return null;
  const attacks = getRangedAttacksFromItem(item);
  if (!attacks.length) return null;

  const uuid = String(entry?.uuid ?? '');
  if (uuid) {
    const byUuid = attacks.find(attack => String(attack.uuid ?? '') === uuid);
    if (byUuid) return byUuid;
  }

  const mode = String(entry?.mode ?? '').trim().toLowerCase();
  const name = String(entry?.name ?? '').trim().toLowerCase();
  const byMode = attacks.filter(attack => String(attack.mode ?? '').trim().toLowerCase() === mode);
  if (byMode.length === 1) return byMode[0];

  const byName = attacks.find(attack => {
    const sourceName = String(attack.name ?? '').trim().toLowerCase();
    return sourceName && name && (name.includes(sourceName) || sourceName.includes(name));
  });
  if (byName) return byName;
  return attacks.length === 1 ? attacks[0] : null;
}

function findAttackItem(actor, entry) {
  const ids = [entry?.itemid, entry?.fromItem]
    .map(value => String(value ?? ''))
    .filter((value, index, list) => value && list.indexOf(value) === index);
  const items = [];

  for (const id of ids) {
    let item = getItemById(actor, id);
    if (!item && id.includes('.')) item = getItemById(actor, id.split('.').pop());
    if (item && !items.includes(item)) items.push(item);
  }

  // `itemid` may point at the auto-created rangedAtk item while the original
  // static import lives on the parent equipment item referenced by `fromItem`.
  return items.find(item => getRangedAttacksFromItem(item).length) ?? items[0] ?? null;
}

function repairRangedObject(actor, ranged) {
  let changed = false;

  const visit = container => {
    if (!container || typeof container !== 'object') return;
    for (const value of Object.values(container)) {
      if (!value || typeof value !== 'object') continue;

      if ('import' in value || 'level' in value) {
        const item = findAttackItem(actor, value);
        const source = findRangedSource(value, item);

        const sourceImport = source?.import;
        const sourceImportNumber = Number(sourceImport);
        const sourceImportValid =
          sourceImport !== '' && sourceImport !== null && sourceImport !== undefined && Number.isFinite(sourceImportNumber);

        const sourceLevel = source?.level;
        const sourceLevelNumber = Number(sourceLevel);
        const sourceLevelValid =
          sourceLevel !== '' &&
          sourceLevel !== null &&
          sourceLevel !== undefined &&
          Number.isFinite(sourceLevelNumber) &&
          sourceLevelNumber > 0;

        const sourceValue = sourceImportValid ? sourceImport : sourceLevelValid ? sourceLevel : null;
        const sourceValueNumber = Number(sourceValue);
        const sourceValueValid = sourceImportValid || sourceLevelValid;

        const currentImport = Number(value.import);
        const importBroken =
          value.import === '' ||
          value.import === null ||
          value.import === undefined ||
          !Number.isFinite(currentImport);

        const levelNumber = Number(value.level);
        const levelBroken =
          value.level === '' || value.level === null || value.level === undefined || !Number.isFinite(levelNumber);

        const otfValues = [source?.otf, value?.otf]
          .map(entry => String(entry ?? '').trim())
          .filter(Boolean);
        const hasOtf = otfValues.some(otf => /[^\s\-–—]/.test(otf));

        if (importBroken && !hasOtf && sourceValueValid) {
          value.import = String(sourceValue);
          value.level = Math.trunc(sourceValueNumber);
          changed = true;
        } else if (importBroken && !hasOtf && Number.isFinite(levelNumber) && levelNumber > 0) {
          value.import = String(Math.trunc(levelNumber));
          changed = true;
        } else if (!importBroken && levelBroken) {
          value.level = Math.trunc(currentImport);
          changed = true;
        }
      }

      if (value.contains) visit(value.contains);
    }
  };

  visit(ranged);
  return changed;
}

/**
 * Repair GURPS actor ranged components whose skill level was lost during the
 * system item-add workflow (no OTF skill link, static Shots level).
 * Only broken values are filled; valid skill levels are never overwritten.
 */
export async function repairRangedAttackLevels(actor) {
  if (!canManageActor(actor)) return false;
  return withActorLock(actor, () => repairRangedAttackLevelsInternal(actor));
}

async function repairRangedAttackLevelsInternal(actor) {
  const ranged = actor?.system?.ranged;
  if (!ranged || typeof ranged !== 'object') return false;

  const copy = clone(ranged);
  if (!repairRangedObject(actor, copy)) return false;

  try {
    await actor.update({ 'system.ranged': copy });
    return true;
  } catch (err) {
    console.warn(`${MODULE_ID} | Unable to repair ranged skill levels`, err);
    return false;
  }
}

async function ensureInternal(actor, options = {}) {
  if (!canManageActor(actor)) return getActorAmmoEntries(actor);

  const create = options.create ?? getModuleSetting('autoCreateAmmo', true);
  const cleanup = options.cleanup !== false;
  const previousSuppressed = getSuppressedAmmoSources(actor);
  const clearSuppression = !!options.clearSuppression && previousSuppressed.length > 0;
  const suppressedSources = new Set(clearSuppression ? [] : previousSuppressed);

  const originalRoot = getTrackerRoot(actor);
  const originalFlags = getAmmoData(actor);
  const markInitialized = !!options.markInitialized && !isAmmoInitialized(actor);
  const keys = getTrackerKeys(originalRoot);
  const trackers = keys.map(key => clone(originalRoot[key]));

  const keyToIndex = new Map(keys.map((key, index) => [String(key), index]));
  const nameToIndex = new Map();
  trackers.forEach((tracker, index) => {
    const name = String(tracker?.name ?? '').trim();
    if (!name) return;
    if (!nameToIndex.has(name)) nameToIndex.set(name, []);
    nameToIndex.get(name).push(index);
  });

  const desired = new Map();
  for (const item of getActorItems(actor)) {
    if (!item || (item.type !== 'equipment' && item.type !== 'rangedAtk')) continue;
    const info = getItemAmmoInfo(item);
    if (info) desired.set(String(item.id), { item, info });
  }
  for (const raw of getRawRangedAttacks(actor)) {
    const info = getRawAmmoInfo(raw);
    if (info) desired.set(getRawAttackSourceId(raw), { item: null, info, raw });
  }

  const nextEntries = [];
  const usedIndices = new Set();
  const removeIndices = new Set();
  const originalEntriesBySource = new Map(
    originalFlags.entries.map(entry => [String(entry.sourceId), entry])
  );

  for (const entry of originalFlags.entries) {
    const sourceId = String(entry.sourceId);
    const desiredItem = desired.get(sourceId);
    const item = desiredItem?.item ?? getItemById(actor, sourceId);
    const raw = desiredItem?.raw ?? null;
    const info = desiredItem?.info ?? getItemAmmoInfo(item);
    const linkedItem = getLinkedAmmoItem(actor, entry);
    if (entry.linkedItemId && !linkedItem) entry.linkedItemId = '';
    let trackerIndex = trackerIndexForEntry(entry, trackers, keyToIndex, nameToIndex);
    if (trackerIndex >= 0 && usedIndices.has(trackerIndex)) trackerIndex = -1;

    if (!info || (!item && !raw)) {
      if (cleanup && trackerIndex >= 0) removeIndices.add(trackerIndex);
      continue;
    }

    if (trackerIndex < 0) continue;

    const sourceName = String(item?.name ?? raw?.attack?.name ?? entry.name ?? '');
    let trackerKey = '';
    let trackerName = String(entry.trackerName ?? '').trim() || buildTrackerName(sourceName);
    let maxOverride = !!entry.maxOverride;

    if (trackerIndex >= 0) {
      const tracker = trackers[trackerIndex];
      const previousCapacity = toInt(entry.capacity, 0);
      const trackerMax = toInt(tracker.max, previousCapacity);

      if (!maxOverride && previousCapacity > 0 && trackerMax !== previousCapacity) {
        maxOverride = true;
      }
      if (!maxOverride && (!previousCapacity || trackerMax === previousCapacity) && info.capacity !== trackerMax) {
        tracker.max = info.capacity;
        tracker.value = Math.min(toInt(tracker.value, 0), info.capacity);
      }

      const fallbackName = String(entry.trackerName ?? '').trim() || buildTrackerName(sourceName);
      const normalized = normalizeTracker(tracker, fallbackName, info.capacity);
      trackers[trackerIndex] = normalized;
      usedIndices.add(trackerIndex);
      trackerKey = padTrackerKey(trackerIndex);
      trackerName = normalized.name;
    }

    nextEntries.push({
      ...entry,
      sourceId,
      itemUuid: String(item?.uuid ?? entry.itemUuid ?? ''),
      globalId: String(item?.system?.globalid ?? entry.globalId ?? ''),
      rawKey: raw?.path ?? String(entry.rawKey ?? ''),
      rawUuid: raw?.uuid ?? String(entry.rawUuid ?? ''),
      name: sourceName,
      capacity: info.capacity,
      maxOverride,
      ammoType: String(entry.ammoType ?? ''),
      linkedItemId: linkedItem ? String(linkedItem.id) : '',
      trackerKey,
      trackerName,
    });
  }

  if (create) {
    const covered = new Set(nextEntries.map(entry => String(entry.sourceId)));
    for (const [sourceId, record] of desired) {
      if (covered.has(sourceId) || suppressedSources.has(sourceId)) continue;

      const { item, info, raw } = record;
      const sourceName = String(item?.name ?? raw?.attack?.name ?? 'Ranged Attack');
      const existingEntry = originalEntriesBySource.get(sourceId);
      const linkedItem = existingEntry ? getLinkedAmmoItem(actor, existingEntry) : null;
      const baseName = buildTrackerName(sourceName);
      const availableTrackers = trackers.filter((_, index) => !removeIndices.has(index));
      const name = nextUniqueTrackerName(availableTrackers, baseName);
      trackers.push(normalizeTracker({ name, max: info.capacity, value: info.capacity }, name, info.capacity));
      const trackerIndex = trackers.length - 1;
      const tracker = trackers[trackerIndex];
      usedIndices.add(trackerIndex);

      nextEntries.push({
        sourceId,
        itemUuid: String(item?.uuid ?? ''),
        globalId: String(item?.system?.globalid ?? ''),
        rawKey: raw?.path ?? '',
        rawUuid: raw?.uuid ?? '',
        name: sourceName,
        capacity: info.capacity,
        maxOverride: false,
        ammoType: String(existingEntry?.ammoType ?? ''),
        linkedItemId: linkedItem ? String(linkedItem.id) : '',
        trackerKey: padTrackerKey(trackerIndex),
        trackerName: tracker.name,
      });
    }
  }

  const referenced = new Set();
  for (const entry of nextEntries) {
    const numeric = Number.parseInt(String(entry.trackerKey).replace(/\D/g, ''), 10);
    if (Number.isFinite(numeric)) referenced.add(numeric);
  }

  const keptTrackers = [];
  const indexMap = new Map();
  trackers.forEach((tracker, index) => {
    if (removeIndices.has(index) && !referenced.has(index)) return;
    indexMap.set(index, keptTrackers.length);
    keptTrackers.push(tracker);
  });

  const finalEntries = nextEntries.map(entry => {
    const rawKey = String(entry.trackerKey ?? '').trim();
    const oldIndex = rawKey ? Number.parseInt(rawKey.replace(/\D/g, ''), 10) : NaN;
    if (!Number.isFinite(oldIndex)) return { ...entry, trackerKey: '', trackerName: String(entry.trackerName ?? '') };
    const newIndex = indexMap.get(oldIndex) ?? oldIndex;
    return {
      ...entry,
      trackerKey: padTrackerKey(newIndex),
      trackerName: String(keptTrackers[newIndex]?.name ?? entry.trackerName ?? ''),
    };
  });

  const finalRoot = buildTrackerRoot(keptTrackers);

  const rootChanged = JSON.stringify(originalRoot) !== JSON.stringify(finalRoot);
  const flagsChanged = JSON.stringify(originalFlags.entries) !== JSON.stringify(finalEntries);

  if (rootChanged || flagsChanged || markInitialized || clearSuppression) {
    const updates = {};
    if (flagsChanged) updates[`flags.${MODULE_ID}.${AMMO_FLAG}`] = getAmmoFlagObject(finalEntries);
    if (markInitialized) updates[`flags.${MODULE_ID}.${AMMO_INITIALIZED_FLAG}`] = true;
    if (clearSuppression) updates[`flags.${MODULE_ID}.${AMMO_SUPPRESSED_FLAG}`] = [];
    try {
      await commitAmmoUpdate(actor, updates, rootChanged ? finalRoot : undefined);
    } catch (err) {
      console.warn(`${MODULE_ID} | Unable to update ammunition trackers`, err);
    }
  }

  try {
    await repairRangedAttackLevelsInternal(actor);
  } catch (err) {
    console.warn(`${MODULE_ID} | Unable to repair ranged attacks`, err);
  }

  return getActorAmmoEntries(actor);
}

export function ensureAmmoTrackers(actor, options = {}) {
  if (!canManageActor(actor)) return Promise.resolve(getActorAmmoEntries(actor));
  return withActorLock(actor, () => ensureInternal(actor, options));
}

/**
 * Clear the “user deleted this tracker” list. Called by the explicit sync
 * button, which is allowed to recreate trackers again.
 * @param {Actor} actor
 */
export async function clearAmmoSuppression(actor) {
  if (!canManageActor(actor)) return;
  try {
    await actor.update({ [`flags.${MODULE_ID}.${AMMO_SUPPRESSED_FLAG}`]: [] });
  } catch (err) {
    console.warn(`${MODULE_ID} | Unable to reset ammunition suppression`, err);
  }
}

function withActorLock(actor, task) {
  const previous = locks.get(actor) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  locks.set(actor, next);
  return next.finally(() => {
    if (locks.get(actor) === next) locks.delete(actor);
  });
}

export function scheduleEnsureAmmo(actor, options = {}, delay = 250) {
  if (!canManageActor(actor)) return;
  const previous = timers.get(actor);
  const merged = {
    ...(previous?.options ?? {}),
    ...options,
    create: !!(previous?.options?.create || options.create),
  };
  if (previous?.timer) clearTimeout(previous.timer);
  const timer = setTimeout(() => {
    timers.delete(actor);
    void ensureAmmoTrackers(actor, merged);
  }, delay);
  timers.set(actor, { timer, options: merged });
}

/**
 * Remove specific ammunition trackers by key and reindex mappings. Used by the
 * bulk cleanup button so it deletes exactly the rows the user sees.
 * @param {Actor} actor
 * @param {string[]} trackerKeys
 * @returns {Promise<boolean>}
 */
export async function removeAmmoTrackerKeys(actor, trackerKeys) {
  if (!canManageActor(actor)) return false;
  return withActorLock(actor, () => removeTrackerKeysInternal(actor, trackerKeys));
}

async function removeTrackerKeysInternal(actor, trackerKeys) {
  const removeKeys = new Set(
    (Array.isArray(trackerKeys) ? trackerKeys : [])
      .map(key => String(key ?? '').trim())
      .filter(Boolean)
  );
  if (!removeKeys.size) return false;

  const originalRoot = getTrackerRoot(actor);
  const originalFlags = getAmmoData(actor);
  const keys = getTrackerKeys(originalRoot);
  const existingKeys = new Set(keys);
  for (const key of removeKeys) {
    if (!existingKeys.has(key)) removeKeys.delete(key);
  }
  if (!removeKeys.size) return false;

  const keptTrackers = [];
  const indexMap = new Map();
  keys.forEach((key, index) => {
    if (removeKeys.has(key)) return;
    indexMap.set(index, keptTrackers.length);
    keptTrackers.push(clone(originalRoot[key]));
  });

  const finalEntries = originalFlags.entries
    .map(entry => {
      const rawKey = String(entry.trackerKey ?? '').trim();
      const oldIndex = rawKey ? Number.parseInt(rawKey.replace(/\D/g, ''), 10) : NaN;
      if (!Number.isFinite(oldIndex)) return { ...entry, trackerKey: '', trackerName: String(entry.trackerName ?? '') };
      if (removeKeys.has(rawKey)) return null;
      const newIndex = indexMap.get(oldIndex);
      if (newIndex === undefined) return null;
      return {
        ...entry,
        trackerKey: padTrackerKey(newIndex),
        trackerName: String(keptTrackers[newIndex]?.name ?? entry.trackerName ?? ''),
      };
    })
    .filter(Boolean);

  const finalRoot = buildTrackerRoot(keptTrackers);

  try {
    await commitAmmoUpdate(
      actor,
      {
        [`flags.${MODULE_ID}.${AMMO_FLAG}`]: getAmmoFlagObject(finalEntries),
        [`flags.${MODULE_ID}.${AMMO_INITIALIZED_FLAG}`]: true,
      },
      finalRoot
    );
    return true;
  } catch (err) {
    console.warn(`${MODULE_ID} | Unable to remove ammunition trackers`, err);
    return false;
  }
}

/**
 * Remove all ammunition-looking trackers which are not referenced by an ammo
 * mapping. Used by the bulk cleanup button for stale trackers from old versions.
 * @param {Actor} actor
 * @returns {Promise<boolean>}
 */
export async function removeOrphanAmmoTrackers(actor) {
  if (!canManageActor(actor)) return false;
  return withActorLock(actor, () => removeOrphanTrackersInternal(actor));
}

async function removeOrphanTrackersInternal(actor) {
  const originalRoot = getTrackerRoot(actor);
  const originalFlags = getAmmoData(actor);
  const keys = getTrackerKeys(originalRoot);
  if (!keys.length) return false;

  const referenced = new Set(
    originalFlags.entries.map(entry => String(entry.trackerKey ?? '').trim()).filter(Boolean)
  );
  const removeKeys = new Set(
    keys.filter(key => !referenced.has(key) && isAmmoTrackerName(originalRoot[key]?.name))
  );
  if (!removeKeys.size) return false;

  const keptTrackers = [];
  const indexMap = new Map();
  keys.forEach((key, index) => {
    if (removeKeys.has(key)) return;
    indexMap.set(index, keptTrackers.length);
    keptTrackers.push(clone(originalRoot[key]));
  });

  const finalEntries = originalFlags.entries.map(entry => {
    const rawKey = String(entry.trackerKey ?? '').trim();
    const oldIndex = rawKey ? Number.parseInt(rawKey.replace(/\D/g, ''), 10) : NaN;
    if (!Number.isFinite(oldIndex)) return { ...entry, trackerKey: '', trackerName: String(entry.trackerName ?? '') };
    const newIndex = indexMap.get(oldIndex);
    if (newIndex === undefined) return { ...entry, trackerKey: '', trackerName: String(entry.trackerName ?? '') };
    return {
      ...entry,
      trackerKey: padTrackerKey(newIndex),
      trackerName: String(keptTrackers[newIndex]?.name ?? entry.trackerName ?? ''),
    };
  });

  const finalRoot = buildTrackerRoot(keptTrackers);

  try {
    await commitAmmoUpdate(
      actor,
      {
        [`flags.${MODULE_ID}.${AMMO_FLAG}`]: getAmmoFlagObject(finalEntries),
        [`flags.${MODULE_ID}.${AMMO_INITIALIZED_FLAG}`]: true,
      },
      finalRoot
    );
    return true;
  } catch (err) {
    console.warn(`${MODULE_ID} | Unable to clean up ammunition trackers`, err);
    return false;
  }
}

/**
 * Remove a single stale/orphan ammunition tracker and reindex the remaining
 * trackers and mappings. Used by the delete button on orphan rows.
 * @param {Actor} actor
 * @param {string} trackerKey
 * @returns {Promise<boolean>}
 */
export async function removeAmmoTracker(actor, trackerKey) {
  if (!canManageActor(actor)) return false;
  return withActorLock(actor, () => removeTrackerInternal(actor, trackerKey));
}

async function removeTrackerInternal(actor, trackerKey) {
  const key = String(trackerKey ?? '');
  const originalRoot = getTrackerRoot(actor);
  if (!key || !originalRoot[key]) return false;

  const originalFlags = getAmmoData(actor);
  const keys = getTrackerKeys(originalRoot);
  const removedIndex = keys.indexOf(key);
  if (removedIndex < 0) return false;

  const trackers = keys.map(itemKey => clone(originalRoot[itemKey]));
  const keptTrackers = trackers.filter((_, index) => index !== removedIndex);

  const finalEntries = [];
  for (const entry of originalFlags.entries) {
    const oldKey = String(entry.trackerKey ?? '').trim();
    const oldIndex = oldKey ? Number.parseInt(oldKey.replace(/\D/g, ''), 10) : NaN;
    if (!Number.isFinite(oldIndex)) {
      finalEntries.push({ ...entry, trackerKey: '', trackerName: String(entry.trackerName ?? '') });
      continue;
    }
    if (oldIndex === removedIndex) continue;

    const newIndex = oldIndex > removedIndex ? oldIndex - 1 : oldIndex;
    finalEntries.push({
      ...entry,
      trackerKey: padTrackerKey(newIndex),
      trackerName: String(keptTrackers[newIndex]?.name ?? entry.trackerName ?? ''),
    });
  }

  const finalRoot = buildTrackerRoot(keptTrackers);

  const updates = {
    [`flags.${MODULE_ID}.${AMMO_FLAG}`]: getAmmoFlagObject(finalEntries),
    [`flags.${MODULE_ID}.${AMMO_INITIALIZED_FLAG}`]: true,
  };
  try {
    await commitAmmoUpdate(actor, updates, finalRoot);
    return true;
  } catch (err) {
    console.warn(`${MODULE_ID} | Unable to remove ammunition tracker`, err);
    return false;
  }
}

/**
 * Remove the tracker belonging to one embedded item of one actor.
 * Other actors holding copies of the same world item are never touched.
 * @param {Actor} actor
 * @param {string} itemId embedded Item id
 * @returns {Promise<boolean>}
 */
export async function removeAmmoForItem(actor, itemId, trackerKey = '') {
  if (!canManageActor(actor)) return false;
  return withActorLock(actor, () => removeInternal(actor, itemId, trackerKey));
}

async function removeInternal(actor, itemId, explicitTrackerKey = '') {
  const sourceId = String(itemId ?? '');
  if (!sourceId) return false;

  const originalRoot = getTrackerRoot(actor);
  const originalFlags = getAmmoData(actor);
  const targets = originalFlags.entries.filter(entry => String(entry.sourceId) === sourceId);
  if (!targets.length) return false;

  const keys = getTrackerKeys(originalRoot);
  const trackers = keys.map(key => clone(originalRoot[key]));
  const keyToIndex = new Map(keys.map((key, index) => [String(key), index]));
  const nameToIndex = new Map();
  trackers.forEach((tracker, index) => {
    const name = String(tracker?.name ?? '').trim();
    if (!name) return;
    if (!nameToIndex.has(name)) nameToIndex.set(name, []);
    nameToIndex.get(name).push(index);
  });

  const entryIndices = new Map();
  for (const entry of originalFlags.entries) {
    entryIndices.set(entry, trackerIndexForEntry(entry, trackers, keyToIndex, nameToIndex));
  }

  const targetIndices = new Set();
  for (const entry of targets) {
    const index = entryIndices.get(entry);
    if (index >= 0) targetIndices.add(index);
  }
  const explicitKey = String(explicitTrackerKey ?? '').trim();
  if (explicitKey && keyToIndex.has(explicitKey)) targetIndices.add(keyToIndex.get(explicitKey));

  const keptEntries = originalFlags.entries.filter(entry => {
    if (String(entry.sourceId) === sourceId) return false;
    const index = entryIndices.get(entry);
    return (Number.isFinite(index) && index >= 0) || !!getLinkedAmmoItem(actor, entry);
  });
  const referenced = new Set(
    keptEntries.map(entry => entryIndices.get(entry)).filter(index => Number.isFinite(index) && index >= 0)
  );

  const keptTrackers = [];
  const indexMap = new Map();
  trackers.forEach((tracker, index) => {
    if (targetIndices.has(index) && !referenced.has(index)) return;
    indexMap.set(index, keptTrackers.length);
    keptTrackers.push(tracker);
  });

  const finalEntries = keptEntries.map(entry => {
    const oldIndex = entryIndices.get(entry);
    if (!Number.isFinite(oldIndex) || oldIndex < 0) {
      return { ...entry, trackerKey: '', trackerName: String(entry.trackerName ?? '') };
    }
    const newIndex = indexMap.get(oldIndex) ?? oldIndex;
    return {
      ...entry,
      trackerKey: padTrackerKey(newIndex),
      trackerName: String(keptTrackers[newIndex]?.name ?? entry.trackerName ?? ''),
    };
  });

  const finalRoot = buildTrackerRoot(keptTrackers);

  const rootChanged = JSON.stringify(originalRoot) !== JSON.stringify(finalRoot);
  const flagsChanged = JSON.stringify(originalFlags.entries) !== JSON.stringify(finalEntries);
  if (!rootChanged && !flagsChanged) return false;

  try {
    const suppressed = new Set(getSuppressedAmmoSources(actor));
    suppressed.add(sourceId);
    const updates = {
      [`flags.${MODULE_ID}.${AMMO_FLAG}`]: getAmmoFlagObject(finalEntries),
      [`flags.${MODULE_ID}.${AMMO_INITIALIZED_FLAG}`]: true,
      [`flags.${MODULE_ID}.${AMMO_SUPPRESSED_FLAG}`]: Array.from(suppressed),
    };
    await commitAmmoUpdate(actor, updates, rootChanged ? finalRoot : undefined);
    return true;
  } catch (err) {
    console.warn(`${MODULE_ID} | Unable to remove ammunition tracker`, err);
    return false;
  }
}

/**
 * Set current/max ammunition for one mapped weapon.
 * @param {Actor} actor
 * @param {string} sourceId embedded Item id
 * @param {{value?:number, max?:number, maxOverride?:boolean}} values
 */
export async function setAmmoValues(actor, sourceId, values = {}) {
  if (!canManageActor(actor)) return null;

  const data = getAmmoData(actor);
  const index = data.entries.findIndex(entry => String(entry.sourceId) === String(sourceId));
  if (index < 0) return null;

  const entry = data.entries[index];
  const trackerKey = resolveTrackerKey(actor, entry);
  const tracker = getTracker(actor, trackerKey);
  if (!trackerKey || !tracker) {
    await ensureAmmoTrackers(actor, { create: true, cleanup: true });
    return null;
  }

  const currentMax = toInt(tracker.max, entry.capacity ?? 0);
  const nextMax = values.max === undefined ? currentMax : Math.max(0, toInt(values.max, currentMax));
  const requestedValue = values.value === undefined ? toInt(tracker.value, 0) : toInt(values.value, 0);
  const nextValue = clampInt(requestedValue, 0, nextMax);

  const updates = {};
  if (values.value !== undefined || nextValue !== toInt(tracker.value, 0)) {
    updates[`system.additionalresources.tracker.${trackerKey}.value`] = nextValue;
  }
  if (values.max !== undefined && nextMax !== currentMax) {
    updates[`system.additionalresources.tracker.${trackerKey}.max`] = nextMax;
  }
  if (values.maxOverride) {
    entry.maxOverride = true;
    data.entries[index] = entry;
    updates[`flags.${MODULE_ID}.${AMMO_FLAG}`] = getAmmoFlagObject(data.entries);
  }

  if (Object.keys(updates).length) {
    try {
      await actor.update(updates);
    } catch (err) {
      console.warn(`${MODULE_ID} | Unable to update ammunition values`, err);
    }
  }

  return { value: nextValue, max: nextMax };
}

/**
 * Reload a weapon from its linked ammunition-reserve item. The reserve's
 * `system.eqt.count` is reduced by the number of rounds loaded into the
 * magazine. The weapon's resource tracker remains the loaded magazine.
 * @param {Actor} actor
 * @param {string} sourceId
 */
export async function reloadAmmo(actor, sourceId) {
  if (!canManageActor(actor)) return null;

  const data = getAmmoData(actor);
  const entry = data.entries.find(item => String(item.sourceId) === String(sourceId));
  if (!entry) return null;

  const trackerKey = resolveTrackerKey(actor, entry);
  const tracker = getTracker(actor, trackerKey);
  if (!trackerKey || !tracker) return null;

  const capacity = Math.max(0, toInt(tracker.max, entry.capacity ?? 0));
  const current = Math.max(0, toInt(tracker.value, 0));
  const linkedItem = getLinkedAmmoItem(actor, entry);

  if (!linkedItem) {
    const result = await setAmmoValues(actor, sourceId, { value: capacity });
    return result ? { reloaded: Math.max(0, capacity - current), ...result, reserve: null } : null;
  }

  if (current >= capacity) {
    notify('info', localize('GURPSITEMODERN.Ammo.AlreadyFull', {}, 'Magazine is already full'));
    return { reloaded: 0, value: current, max: capacity, reserve: getItemCount(linkedItem) };
  }

  const reserve = getItemCount(linkedItem);
  if (reserve <= 0) {
    notify('warn', localize('GURPSITEMODERN.Ammo.NoReserve', {}, 'No ammunition in the linked reserve'));
    return { reloaded: 0, value: current, max: capacity, reserve: 0 };
  }

  const needed = Math.max(0, capacity - current);
  const reloaded = Math.min(needed, reserve);
  const nextValue = current + reloaded;
  const nextReserve = reserve - reloaded;

  try {
    if (reloaded > 0) await linkedItem.update({ 'system.eqt.count': nextReserve });
    await actor.update({ [`system.additionalresources.tracker.${trackerKey}.value`]: nextValue });
  } catch (err) {
    console.warn(`${MODULE_ID} | Unable to reload ammunition`, err);
    return null;
  }

  if (reloaded < needed) {
    notify(
      'warn',
      localize(
        'GURPSITEMODERN.Ammo.NotEnoughReserve',
        { loaded: reloaded, needed, reserve: nextReserve },
        `Reloaded only ${reloaded} of ${needed} rounds; the reserve is empty`
      )
    );
  }

  return { reloaded, value: nextValue, max: capacity, reserve: nextReserve };
}

/**
 * Store the free-form ammunition type label for one weapon mapping.
 * @param {Actor} actor
 * @param {string} sourceId
 * @param {string} ammoType
 */
export async function setAmmoType(actor, sourceId, ammoType) {
  if (!canManageActor(actor)) return null;
  const data = getAmmoData(actor);
  const index = data.entries.findIndex(entry => String(entry.sourceId) === String(sourceId));
  if (index < 0) return null;

  const value = String(ammoType ?? '')
    .trim()
    .slice(0, 120);
  const entry = { ...data.entries[index], ammoType: value };
  if (String(data.entries[index].ammoType ?? '') === value) return entry;

  data.entries[index] = entry;
  try {
    await actor.update({ [`flags.${MODULE_ID}.${AMMO_FLAG}`]: getAmmoFlagObject(data.entries) });
    return entry;
  } catch (err) {
    console.warn(`${MODULE_ID} | Unable to update ammunition type`, err);
    return null;
  }
}

/**
 * Link or unlink an ammunition mapping to another actor item's uses counter.
 * @param {Actor} actor
 * @param {string} sourceId weapon embedded Item id
 * @param {string} linkedItemId linked embedded Item id, empty to unlink
 */
export async function setAmmoLink(actor, sourceId, linkedItemId) {
  if (!canManageActor(actor)) return null;
  const data = getAmmoData(actor);
  const index = data.entries.findIndex(entry => String(entry.sourceId) === String(sourceId));
  if (index < 0) return null;

  const id = String(linkedItemId ?? '').trim();
  let item = null;
  if (id) {
    item = getItemById(actor, id) ?? (id.includes('.') ? getItemById(actor, id.split('.').pop()) : null);
    if (!item || !item.system?.eqt || String(item.id) === String(sourceId)) return null;
  }

  const entry = { ...data.entries[index], linkedItemId: item ? String(item.id) : '' };
  data.entries[index] = entry;
  try {
    await actor.update({ [`flags.${MODULE_ID}.${AMMO_FLAG}`]: getAmmoFlagObject(data.entries) });
    return {
      ...entry,
      linkedItem: item,
      reserve: item ? getItemCount(item) : 0,
    };
  } catch (err) {
    console.warn(`${MODULE_ID} | Unable to link ammunition`, err);
    return null;
  }
}

/**
 * Spend shots from one mapped weapon after a confirmed attack roll.
 * @param {Actor} actor
 * @param {object|string} entryOrSourceId
 * @param {number} shots
 */
export async function spendAmmo(actor, entryOrSourceId, shots) {
  if (!canManageActor(actor)) return null;

  const sourceId = typeof entryOrSourceId === 'string' ? entryOrSourceId : entryOrSourceId?.sourceId;
  const data = getAmmoData(actor);
  const entry = data.entries.find(item => String(item.sourceId) === String(sourceId));
  if (!entry) return null;

  const trackerKey = resolveTrackerKey(actor, entry);
  const tracker = getTracker(actor, trackerKey);
  if (!trackerKey || !tracker) {
    console.warn(`${MODULE_ID} | Ammunition tracker is missing for ${entry.name}`);
    return null;
  }

  const current = Math.max(0, toInt(tracker.value, 0));
  const requested = Math.max(1, toInt(shots, 1));
  const spent = Math.min(requested, current);
  const next = Math.max(0, current - spent);

  if (spent <= 0) {
    notify('warn', localize('GURPSITEMODERN.Ammo.Empty', { weapon: entry.name }, 'Out of ammunition'));
    return { spent: 0, value: current, max: toInt(tracker.max, 0) };
  }

  if (spent < requested) {
    notify(
      'warn',
      localize(
        'GURPSITEMODERN.Ammo.NotEnough',
        { weapon: entry.name, requested, spent },
        `${entry.name}: only ${spent} of ${requested} shots were available`
      )
    );
  }

  try {
    await actor.update({ [`system.additionalresources.tracker.${trackerKey}.value`]: next });
  } catch (err) {
    console.warn(`${MODULE_ID} | Unable to spend ammunition`, err);
    return null;
  }

  return { spent, value: next, max: toInt(tracker.max, 0) };
}

/**
 * Register Foundry hooks which keep trackers in sync with embedded items.
 * Only the client that initiated the change performs the write; every call is
 * scoped to the actor that owns the item.
 */
export function registerAmmoSyncHooks() {
  const hooks = globalThis.Hooks;
  if (!hooks?.on) return;

  const isInitiator = userId => !userId || !getGame()?.user?.id || userId === getGame().user.id;

  const onItemChanged = (item, _changes, userId, create) => {
    if (!isInitiator(userId)) return;
    const actor = item?.parent;
    if (!actor || actor.documentName !== 'Actor') return;
    scheduleEnsureAmmo(actor, { create, cleanup: true }, 300);
  };

  hooks.on('createItem', (item, options, userId) => onItemChanged(item, options, userId, true));
  hooks.on('updateItem', (item, changes, options, userId) => onItemChanged(item, changes, userId, false));

  hooks.on('preUpdateActor', (actor, _changes, _options, _userId) => {
    if (!actor || actor.documentName !== 'Actor') return;
    knownRawAttacks.set(actor, new Set(getRawRangedAttacks(actor).map(getRawAttackSourceId)));
  });

  hooks.on('updateActor', (actor, changes, _options, userId) => {
    if (!isInitiator(userId)) return;
    if (!actor || actor.documentName !== 'Actor') return;
    const system = changes?.system;
    if (!system || typeof system !== 'object') return;
    const rangedChanged = Object.keys(system).some(key => key === 'ranged' || key.startsWith('ranged.'));
    if (!rangedChanged) return;

    const previousRaw = knownRawAttacks.get(actor);
    const currentRaw = getRawRangedAttacks(actor).map(getRawAttackSourceId);
    const hasNewRaw = !!previousRaw && currentRaw.some(sourceId => !previousRaw.has(sourceId));
    knownRawAttacks.set(actor, new Set(currentRaw));

    scheduleEnsureAmmo(actor, { create: hasNewRaw, cleanup: true }, 100);
  });

  hooks.on('preDeleteItem', (item, _options, userId) => {
    if (!isInitiator(userId)) return;
    const actor = item?.parent;
    if (!actor || actor.documentName !== 'Actor') return;
    pendingDeletedDocs.set(item, actor);
    const key = String(item.uuid || item.id || '');
    if (!key) return;
    const timer = setTimeout(() => pendingDeletedActors.delete(key), 60000);
    timer.unref?.();
    pendingDeletedActors.set(key, { actor, itemId: item.id, timer });
  });

  hooks.on('deleteItem', (item, _options, userId) => {
    if (!isInitiator(userId)) return;
    const cacheKey = String(item?.uuid || item?.id || '');
    const cached = cacheKey ? pendingDeletedActors.get(cacheKey) : null;
    if (cacheKey) pendingDeletedActors.delete(cacheKey);
    if (cached?.timer) clearTimeout(cached.timer);

    const actor = item?.parent ?? pendingDeletedDocs.get(item) ?? cached?.actor ?? null;
    if (!actor || actor.documentName !== 'Actor') return;
    if (actor._deleting) return;
    const actors = getGame()?.actors;
    if (actors?.has && !actors.has(actor.id)) return;
    void removeAmmoForItem(actor, item.id ?? cached?.itemId);
  });
}





