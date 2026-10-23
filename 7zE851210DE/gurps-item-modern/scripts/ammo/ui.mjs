/**
 * Ammunition UI for the Modern actor sheet.
 *
 * A compact "Ammunition" card is injected into the Combat tab (PC modern sheet)
 * or the main body (NPC modern sheet). Values are stored in native GURPS
 * Resource Trackers, so they are also available in the Notes tab and in the
 * legacy sheet.
 */

import {
  getActorAmmoEntries,
  getActorItems,
  getAmmoData,
  getAmmoSourceIds,
  getItemCount,
  getSuppressedAmmoSources,
  isAmmoInitialized,
  MODULE_ID,
} from './data.mjs';
import {
  canManageActor,
  ensureAmmoTrackers,
  getModuleSetting,
  localize,
  removeAmmoForItem,
  removeAmmoTracker,
  removeAmmoTrackerKeys,
  removeOrphanAmmoTrackers,
  reloadAmmo,
  setAmmoLink,
  setAmmoType,
  setAmmoValues,
} from './sync.mjs';

function escapeHTML(value) {
  const utils = globalThis.foundry?.utils;
  if (typeof utils?.escapeHTML === 'function') return utils.escapeHTML(String(value ?? ''));
  return String(value ?? '').replace(/[&<>"']/g, character => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#039;';
    }
  });
}

function text(key, fallback, data = {}) {
  return localize(key, data, fallback);
}

function isModernSheet(app) {
  return !!app?.element?.find?.('.modern-sheet').length;
}

function getTarget(app) {
  const element = app?.element;
  if (!element?.length) return null;

  const tab = element.find('.ms-body .tab[data-tab="combat"]');
  if (tab.length) {
    const anchor = tab.find('.ms-combat-bottom');
    return { container: tab, anchor: anchor.length ? anchor : null };
  }

  const npcBody = element.find('.ms-npc-body');
  if (npcBody.length) return { container: npcBody, anchor: null };

  return null;
}

/* -------------------------------------------- */
/*  Scroll preservation                         */
/* -------------------------------------------- */

const pendingScroll = new WeakMap();
const SCROLL_SELECTORS = ['.ms-body', '.ms-npc-body', '.window-content', '.tab.active', '.ms-tab-content'];

function getAppRoot(app) {
  return app?.element?.[0] ?? app?.element ?? null;
}

function captureSheetScroll(app) {
  const root = getAppRoot(app);
  if (!root?.querySelectorAll) return [];
  const state = [];
  const seen = new Set();

  for (const selector of SCROLL_SELECTORS) {
    const elements = root.querySelectorAll(selector);
    elements.forEach((element, index) => {
      if (seen.has(element)) return;
      seen.add(element);
      state.push({
        selector,
        index,
        top: Math.max(0, Number(element.scrollTop) || 0),
        left: Math.max(0, Number(element.scrollLeft) || 0),
      });
    });
  }

  return state;
}

function restoreSheetScroll(app, state) {
  if (!Array.isArray(state) || !state.length) return;
  const root = getAppRoot(app);
  if (!root?.querySelectorAll) return;

  for (const entry of state) {
    const element = root.querySelectorAll(entry.selector)[entry.index];
    if (!element) continue;
    if (element.scrollTop !== entry.top) element.scrollTop = entry.top;
    if (element.scrollLeft !== entry.left) element.scrollLeft = entry.left;
  }
}

/**
 * GURPS re-renders the whole actor sheet after many document updates. Without
 * restoring the scroll position the user is thrown back to the top of the
 * Combat tab whenever they press synchronise/reload/delete.
 */
function armScrollPreservation(app) {
  if (pendingScroll.has(app)) return;
  const state = captureSheetScroll(app);
  if (!state.length) return;

  pendingScroll.set(app, state);
  const restore = () => restoreSheetScroll(app, state);
  const timers = [
    setTimeout(restore, 0),
    setTimeout(restore, 100),
    setTimeout(restore, 350),
    setTimeout(() => {
      restore();
      if (pendingScroll.get(app) === state) pendingScroll.delete(app);
    }, 1500),
  ];

  for (const timer of timers) timer?.unref?.();
}

function restorePendingScroll(app) {
  const state = pendingScroll.get(app);
  if (!state) return;
  const restore = () => restoreSheetScroll(app, state);
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
  setTimeout(restore, 0);
  setTimeout(restore, 100);
}

function buildRow(entry, editable, linkItems) {
  const orphan = !!entry.orphan;
  const rowEditable = editable && !orphan;
  const disabled = rowEditable ? '' : ' disabled';
  const deleteDisabled = editable ? '' : ' disabled';
  const name = escapeHTML(entry.name || entry.trackerName || '');
  const value = Number.isFinite(Number(entry.value)) ? Math.max(0, Math.trunc(Number(entry.value))) : 0;
  const max = Number.isFinite(Number(entry.max)) ? Math.max(0, Math.trunc(Number(entry.max))) : 0;
  const ammoType = escapeHTML(entry.ammoType ?? '');
  const currentLabel = escapeHTML(text('GURPSITEMODERN.Ammo.Current', 'Current ammunition'));
  const maxLabel = escapeHTML(text('GURPSITEMODERN.Ammo.Max', 'Maximum ammunition'));
  const resetLabel = escapeHTML(
    entry.linkedItem
      ? text('GURPSITEMODERN.Ammo.Reload', 'Reload from ammunition reserve')
      : text('GURPSITEMODERN.Ammo.Reset', 'Reset to maximum')
  );
  const deleteLabel = escapeHTML(text('GURPSITEMODERN.Ammo.Delete', 'Delete ammunition tracker'));
  const typeLabel = escapeHTML(text('GURPSITEMODERN.Ammo.Type', 'Ammunition type'));
  const typePlaceholder = escapeHTML(text('GURPSITEMODERN.Ammo.TypePlaceholder', 'Ammo type'));
  const linkLabel = escapeHTML(text('GURPSITEMODERN.Ammo.Link', 'Ammunition reserve item'));
  const notLinked = escapeHTML(text('GURPSITEMODERN.Ammo.NotLinked', 'No reserve'));
  const linkedId = String(entry.linkedItemId ?? '');

  const options = [`<option value="">${notLinked}</option>`];
  for (const item of linkItems) {
    if (!item?.system?.eqt || String(item.id) === String(entry.sourceId)) continue;
    const count = getItemCount(item);
    const selected = String(item.id) === linkedId ? ' selected' : '';
    options.push(`<option value="${escapeHTML(item.id)}"${selected}>${escapeHTML(item.name)} (${count})</option>`);
  }
  if (linkedId && !linkItems.some(item => String(item.id) === linkedId)) {
    options.push(
      `<option value="${escapeHTML(linkedId)}" selected>${escapeHTML(entry.linkedItemName || linkedId)}</option>`
    );
  }

  const meta = orphan
    ? ''
    : `<div class="gim-ammo-meta">
        <input class="gim-ammo-input gim-ammo-type" type="text" maxlength="120" value="${ammoType}"
          placeholder="${typePlaceholder}" title="${typeLabel}" aria-label="${typeLabel}"${disabled} />
        <select class="gim-ammo-link" title="${linkLabel}" aria-label="${linkLabel}"${disabled}>${options.join('')}</select>
      </div>`;

  return `
    <div class="gim-ammo-row${orphan ? ' gim-ammo-row--orphan' : ''}" data-source-id="${escapeHTML(
      entry.sourceId
    )}" data-tracker-key="${escapeHTML(entry.trackerKey ?? '')}" data-orphan="${orphan ? 'true' : 'false'}">
      <div class="gim-ammo-main">
        <span class="gim-ammo-name" title="${name}">${name}</span>
        <div class="gim-ammo-fields">
          <input class="gim-ammo-input gim-ammo-current" type="number" min="0" step="1" value="${value}"
            title="${currentLabel}" aria-label="${currentLabel}"${disabled} />
          <span class="gim-ammo-separator">/</span>
          <input class="gim-ammo-input gim-ammo-max" type="number" min="0" step="1" value="${max}"
            title="${maxLabel}" aria-label="${maxLabel}"${disabled} />
        </div>
        <button type="button" class="gim-ammo-reset" data-action="reset" title="${resetLabel}"
          aria-label="${resetLabel}"${disabled}>
          <i class="fa-solid fa-rotate-left"></i>
        </button>
        <button type="button" class="gim-ammo-delete" data-action="delete" title="${deleteLabel}"
          aria-label="${deleteLabel}"${deleteDisabled}>
          <i class="fa-solid fa-trash"></i>
        </button>
      </div>
      ${meta}
    </div>
  `;
}

function buildSection(actor, entries) {
  const editable = canManageActor(actor);
  const title = escapeHTML(text('GURPSITEMODERN.Ammo.Section', 'Ammunition'));
  const syncLabel = escapeHTML(text('GURPSITEMODERN.Ammo.Sync', 'Synchronise ammunition trackers'));
  const cleanupLabel = escapeHTML(text('GURPSITEMODERN.Ammo.Cleanup', 'Delete stale ammunition trackers'));
  const linkItems = getActorItems(actor);
  const rows = entries.map(entry => buildRow(entry, editable, linkItems)).join('');
  const cleanupButton =
    editable && entries.some(entry => entry.orphan)
      ? `<button type="button" class="gim-ammo-cleanup" data-action="cleanup" title="${cleanupLabel}" aria-label="${cleanupLabel}">
           <i class="fa-solid fa-broom"></i>
         </button>`
      : '';
  const syncButton = editable
    ? `<button type="button" class="gim-ammo-sync" data-action="sync" title="${syncLabel}" aria-label="${syncLabel}">
         <i class="fa-solid fa-arrows-rotate"></i>
       </button>`
    : '';

  return `
    <div class="ms-section gim-ammo-section" data-gim-ammo>
      <h3 class="ms-section-header gim-ammo-header">
        <i class="fa-solid fa-boxes-stacked"></i>
        <span>${title}</span>
        ${cleanupButton}
        ${syncButton}
      </h3>
      <div class="gim-ammo-list">${rows}</div>
    </div>
  `;
}

function rowForSource(section, sourceId) {
  return section.find('.gim-ammo-row').filter((_, element) => element.dataset.sourceId === sourceId);
}

function bindPanel(app, section, actor) {
  section.off('.gim-ammo');

  const captureBeforeInteraction = () => armScrollPreservation(app);
  section.on(
    'pointerdown.gim-ammo mousedown.gim-ammo focusin.gim-ammo',
    '.gim-ammo-link, .gim-ammo-sync, .gim-ammo-reset, .gim-ammo-delete, .gim-ammo-cleanup, .gim-ammo-input',
    captureBeforeInteraction
  );

  section.on('keydown.gim-ammo', '.gim-ammo-input', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.blur();
    }
  });

  section.on('change.gim-ammo', '.gim-ammo-current', async event => {
    event.preventDefault();
    const row = event.currentTarget.closest('.gim-ammo-row');
    const sourceId = row?.dataset?.sourceId;
    if (!sourceId) return;
    armScrollPreservation(app);
    const value = Math.max(0, Math.trunc(Number(event.currentTarget.value) || 0));
    const result = await setAmmoValues(actor, sourceId, { value });
    if (result) {
      const target = rowForSource(section, sourceId);
      target.find('.gim-ammo-current').val(result.value);
      target.find('.gim-ammo-max').val(result.max);
    } else if (app.rendered) {
      refreshAmmoPanel(actor);
    }
  });

  section.on('change.gim-ammo', '.gim-ammo-max', async event => {
    event.preventDefault();
    const row = event.currentTarget.closest('.gim-ammo-row');
    const sourceId = row?.dataset?.sourceId;
    if (!sourceId) return;
    armScrollPreservation(app);
    const max = Math.max(0, Math.trunc(Number(event.currentTarget.value) || 0));
    const currentInput = row.querySelector('.gim-ammo-current');
    const value = Math.max(0, Math.trunc(Number(currentInput?.value) || 0));
    const result = await setAmmoValues(actor, sourceId, { max, value, maxOverride: true });
    if (result) {
      const target = rowForSource(section, sourceId);
      target.find('.gim-ammo-current').val(result.value);
      target.find('.gim-ammo-max').val(result.max);
    }
  });

  section.on('click.gim-ammo', '.gim-ammo-reset', async event => {
    event.preventDefault();
    const row = event.currentTarget.closest('.gim-ammo-row');
    const sourceId = row?.dataset?.sourceId;
    if (!sourceId) return;
    armScrollPreservation(app);

    const entry = getActorAmmoEntries(actor).find(item => String(item.sourceId) === String(sourceId));
    if (entry?.linkedItem) {
      const result = await reloadAmmo(actor, sourceId);
      if (result && app.rendered) injectAmmoPanel(app);
      else if (app.rendered) refreshAmmoPanel(actor);
      return;
    }

    const maxInput = row.querySelector('.gim-ammo-max');
    const max = Math.max(0, Math.trunc(Number(maxInput?.value) || 0));
    const result = await setAmmoValues(actor, sourceId, { value: max });
    if (result) {
      const target = rowForSource(section, sourceId);
      target.find('.gim-ammo-current').val(result.value);
      target.find('.gim-ammo-max').val(result.max);
    }
  });

  section.on('change.gim-ammo', '.gim-ammo-type', async event => {
    event.preventDefault();
    const row = event.currentTarget.closest('.gim-ammo-row');
    const sourceId = row?.dataset?.sourceId;
    if (!sourceId) return;
    armScrollPreservation(app);
    const result = await setAmmoType(actor, sourceId, event.currentTarget.value);
    if (result) event.currentTarget.value = result.ammoType ?? '';
    else if (app.rendered) refreshAmmoPanel(actor);
  });

  section.on('change.gim-ammo', '.gim-ammo-link', async event => {
    event.preventDefault();
    const row = event.currentTarget.closest('.gim-ammo-row');
    const sourceId = row?.dataset?.sourceId;
    if (!sourceId) return;
    armScrollPreservation(app);
    const result = await setAmmoLink(actor, sourceId, event.currentTarget.value);
    if (!result) {
      if (app.rendered) refreshAmmoPanel(actor);
      return;
    }
    await ensureAmmoTrackers(actor, { create: true, cleanup: true });
    if (app.rendered) injectAmmoPanel(app);
  });

  section.on('click.gim-ammo', '.gim-ammo-delete', async event => {
    event.preventDefault();
    const row = event.currentTarget.closest('.gim-ammo-row');
    const sourceId = row?.dataset?.sourceId;
    if (!sourceId) return;
    armScrollPreservation(app);
    const trackerKey =
      row?.dataset?.trackerKey ||
      row?.getAttribute?.('data-tracker-key') ||
      (sourceId.startsWith('__orphan__:') ? sourceId.slice('__orphan__:'.length) : '');
    const removed =
      row?.dataset?.orphan === 'true'
        ? await removeAmmoTracker(actor, trackerKey)
        : await removeAmmoForItem(actor, sourceId, trackerKey);
    if (removed) {
      if (app.rendered) injectAmmoPanel(app);
    } else if (app.rendered) {
      refreshAmmoPanel(actor);
    }
  });

  section.on('click.gim-ammo', '.gim-ammo-cleanup', async event => {
    event.preventDefault();
    armScrollPreservation(app);
    const keys = [];
    section.find('.gim-ammo-row[data-orphan="true"]').each((_, element) => {
      const key = element?.dataset?.trackerKey || element?.getAttribute?.('data-tracker-key') || '';
      if (key) keys.push(key);
    });
    const removedByKeys = keys.length ? await removeAmmoTrackerKeys(actor, keys) : false;
    const removedOrphans = await removeOrphanAmmoTrackers(actor);
    const removed = removedByKeys || removedOrphans;
    if (removed || app.rendered) injectAmmoPanel(app);
  });

  section.on('click.gim-ammo', '.gim-ammo-sync', async event => {
    event.preventDefault();
    armScrollPreservation(app);
    await ensureAmmoTrackers(actor, { create: true, cleanup: true, clearSuppression: true });
    if (app.rendered) injectAmmoPanel(app);
  });
}

export function injectAmmoPanel(app) {
  const actor = app?.actor;
  if (!actor || !app.rendered || !isModernSheet(app)) return;

  const target = getTarget(app);
  if (!target) return;

  app.element.find('.gim-ammo-section').remove();
  const entries = getActorAmmoEntries(actor);
  if (!entries.length) return;

  const html = buildSection(actor, entries);
  if (target.anchor) target.anchor.before(html);
  else target.container.append(html);

  const section = app.element.find('.gim-ammo-section').last();
  if (section.length) bindPanel(app, section, actor);
}

export function refreshAmmoPanel(actor) {
  if (!actor) return;
  const apps = new Set();
  const sheet = actor.sheet;
  if (sheet?.rendered) apps.add(sheet);

  const windows = globalThis.game?.ui?.windows ?? {};
  for (const app of Object.values(windows)) {
    if (app?.actor?.id === actor.id && app.rendered) apps.add(app);
  }

  for (const app of apps) {
    try {
      injectAmmoPanel(app);
    } catch (err) {
      console.warn(`${MODULE_ID} | Unable to refresh ammunition panel`, err);
    }
  }
}

function onRenderActorSheet(app, _html) {
  if (!app?.actor || !isModernSheet(app)) return;

  const autoCreate = getModuleSetting('autoCreateAmmo', true);
  if (!autoCreate || !canManageActor(app.actor)) {
    injectAmmoPanel(app);
    restorePendingScroll(app);
    return;
  }

  const initialized =
    isAmmoInitialized(app.actor) ||
    getAmmoData(app.actor).entries.length > 0 ||
    getActorAmmoEntries(app.actor).length > 0;
  const availableSources = new Set(getActorAmmoEntries(app.actor).map(entry => String(entry.sourceId)));
  const suppressedSources = new Set(getSuppressedAmmoSources(app.actor));
  const hasMissingSource = Array.from(getAmmoSourceIds(app.actor)).some(
    sourceId => !availableSources.has(sourceId) && !suppressedSources.has(sourceId)
  );

  void ensureAmmoTrackers(app.actor, {
    create: !initialized || hasMissingSource,
    cleanup: true,
    markInitialized: true,
  })
    .then(() => {
      if (app.rendered) injectAmmoPanel(app);
      restorePendingScroll(app);
    })
    .catch(err => console.warn(`${MODULE_ID} | Unable to synchronise ammunition`, err));
}

export function registerAmmoUiHooks() {
  const hooks = globalThis.Hooks;
  if (!hooks?.on) return;

  hooks.on('renderGurpsActorSheet', onRenderActorSheet);
  hooks.on('updateActor', actor => {
    setTimeout(() => refreshAmmoPanel(actor), 0);
  });
}

