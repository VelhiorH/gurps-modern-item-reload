/**
 * Ranged attack integration.
 *
 * Wraps GURPS.actionFuncs.attack (delegating, keeping its return value) to:
 *  - block an attack when the mapped tracker is empty;
 *  - limit the system's "number of shots" prompt to the remaining ammunition;
 *  - spend the selected number of shots after a confirmed targeted attack roll.
 *
 * The shot prompt is recognised through the GURPS i18n key, with a
 * locale-independent template fallback, so it works in English and Russian.
 */

import {
  MODULE_ID,
  findAmmoItemForAttack,
  findRawAmmoEntryForAttack,
  getAmmoData,
  getAmmoEntryState,
  getItemAmmoInfo,
  parseRateOfFire,
  toInt,
} from './data.mjs';
import {
  ensureAmmoTrackers,
  getModuleSetting,
  localize,
  notify,
  repairRangedAttackLevels,
  spendAmmo,
} from './sync.mjs';
import { refreshAmmoPanel } from './ui.mjs';

const PROMPT_TITLE_KEY = 'GURPS.combat.rof.numberOfShotsTitle';
const PROMPT_LABEL_KEY = 'GURPS.combat.rof.numberOfShotsLabel';

function getGame() {
  return globalThis.game;
}

function getGurps() {
  return globalThis.GURPS;
}

function getDialogClass() {
  return globalThis.foundry?.applications?.api?.DialogV2 ?? null;
}

function getShotPromptTitle() {
  try {
    return String(getGame()?.i18n?.localize?.(PROMPT_TITLE_KEY) ?? '');
  } catch (err) {
    return '';
  }
}

function isShotPromptOptions(options) {
  const title = String(options?.window?.title ?? '').trim();
  const expected = getShotPromptTitle().trim();
  if (title && expected && title === expected) return true;

  const content = options?.content;
  if (typeof content === 'string') {
    return content.includes('id="get-number-input"') || content.includes("id='get-number-input'");
  }
  return false;
}

function looksLikeUserEvent(event) {
  if (!event || typeof event !== 'object') return false;
  if (globalThis.Event && event instanceof globalThis.Event) return true;
  if (globalThis.Event && event.originalEvent instanceof globalThis.Event) return true;
  if (event.currentTarget && typeof event.currentTarget === 'object' && event.currentTarget.nodeType) return true;
  return typeof event.preventDefault === 'function';
}

function shouldRespectExternalAmmo(event) {
  if (!getModuleSetting('respectExternalAmmo', true)) return false;
  const assistant = getGame()?.modules?.get?.('gga-ammo-resource-assistant');
  if (!assistant?.active) return false;
  return !looksLikeUserEvent(event);
}

function matchesAttackRoll(chatdata, attack) {
  if (!chatdata || !attack) return false;
  const name = String(attack.name ?? '').trim();
  if (!name) return false;

  const chatthing = String(chatdata.chatthing ?? '');
  // Ignore skill/spell checks which may happen before the actual attack roll.
  if (chatthing && !/\[\s*(?:@[^@]*@)?\s*[RA]:/i.test(chatthing)) return false;

  const label = attack.mode ? `${name} (${attack.mode})` : name;
  const haystack = `${chatdata.thing ?? ''} ${chatthing}`.toLowerCase();
  return haystack.includes(name.toLowerCase()) || haystack.includes(label.toLowerCase());
}

function getLabelText(available) {
  try {
    const value = getGame()?.i18n?.format?.(PROMPT_LABEL_KEY, { max: available });
    if (value && value !== PROMPT_LABEL_KEY) return value;
  } catch (err) {
    /* ignore */
  }
  return `Number of shots (1-${available}):`;
}

function adjustShotPrompt(options, available, maximum) {
  if (!options || typeof options.content !== 'string') return options;
  const maxAllowed = Math.max(1, Math.min(toInt(available, 1), toInt(maximum, 1)));

  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(options.content, 'text/html');
      const input = doc.querySelector('input[name="number"]');
      if (input) {
        input.setAttribute('max', String(maxAllowed));
        input.setAttribute('value', '1');

        const label = doc.querySelector('label[for="get-number-input"]');
        if (label) label.textContent = getLabelText(maxAllowed);

        return { ...options, content: doc.body.innerHTML };
      }
    } catch (err) {
      /* fall through to the regex fallback */
    }
  }

  let adjusted = false;
  const content = options.content.replace(/<input\b([^>]*\bname=["']number["'][^>]*)>/i, (full, attributes) => {
    let next = attributes
      .replace(/\smax=(?:"[^"]*"|'[^']*'|[^\s>]+)/i, ` max="${maxAllowed}"`)
      .replace(/\svalue=(?:"[^"]*"|'[^']*'|[^\s>]+)/i, ' value="1"');
    if (!/\bmax=/i.test(next)) next += ` max="${maxAllowed}"`;
    if (!/\bvalue=/i.test(next)) next += ' value="1"';
    adjusted = true;
    return `<input${next}>`;
  });

  return adjusted ? { ...options, content } : options;
}

/* -------------------------------------------- */
/*  Shot prompt capture                         */
/* -------------------------------------------- */

const promptContexts = [];
let promptDepth = 0;
let originalPrompt = null;

function findPromptContext(options) {
  for (let index = promptContexts.length - 1; index >= 0; index -= 1) {
    const context = promptContexts[index];
    if (context.expectsPrompt && !context.promptHandled && isShotPromptOptions(options)) return context;
  }
  return null;
}

async function interceptedPrompt(options, ...rest) {
  const context = findPromptContext(options);
  if (!context) return originalPrompt.call(this, options, ...rest);

  const adjusted = adjustShotPrompt(options, context.available, context.maxRoF);
  let result;
  try {
    result = await originalPrompt.call(this, adjusted, ...rest);
  } catch (err) {
    context.promptHandled = true;
    context.selected = context.defaultSelected;
    return context.defaultSelected;
  }

  context.promptHandled = true;
  const parsed = Number(result);
  const candidate = Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : context.defaultSelected;
  context.selected = Math.max(1, Math.min(candidate, context.maxRoF, context.available));
  return context.selected;
}

function beginPromptCapture(context) {
  if (!context.expectsPrompt) return false;
  const Dialog = getDialogClass();
  if (!Dialog?.prompt) return false;

  promptContexts.push(context);
  if (promptDepth === 0) {
    try {
      originalPrompt = Dialog.prompt;
      Dialog.prompt = interceptedPrompt;
    } catch (err) {
      promptContexts.pop();
      originalPrompt = null;
      return false;
    }
  }
  promptDepth += 1;
  return true;
}

function endPromptCapture(context) {
  if (!context.expectsPrompt) return;
  const index = promptContexts.indexOf(context);
  if (index >= 0) promptContexts.splice(index, 1);
  promptDepth = Math.max(0, promptDepth - 1);
  if (promptDepth === 0 && originalPrompt) {
    const Dialog = getDialogClass();
    if (Dialog) Dialog.prompt = originalPrompt;
    originalPrompt = null;
  }
}

function getActivePromptContext() {
  for (let index = promptContexts.length - 1; index >= 0; index -= 1) {
    const context = promptContexts[index];
    if (context.expectsPrompt && !context.promptHandled) return context;
  }
  return null;
}

/**
 * Safety net for Foundry versions where the prompt content is re-rendered after
 * our pre-render adjustment. It keeps the shot input at one shot and caps it
 * by the remaining ammunition, preventing an accidental RoF bonus.
 */
function onRenderApplicationV2(app) {
  const context = getActivePromptContext();
  if (!context) return;

  const root = app?.element?.[0] ?? app?.element;
  const input = root?.querySelector?.('input[name="number"]');
  if (!input) return;

  const title = String(app?.title ?? app?.options?.window?.title ?? '');
  if (!isShotPromptOptions({ window: { title }, content: root.innerHTML })) return;

  input.max = String(Math.max(1, Math.min(context.available, context.maxRoF)));
  input.value = '1';
}

let promptRenderHookRegistered = false;

function registerPromptRenderHook() {
  if (promptRenderHookRegistered) return;
  const hooks = globalThis.Hooks;
  if (!hooks?.on) return;
  hooks.on('renderApplicationV2', onRenderApplicationV2);
  promptRenderHookRegistered = true;
}

/* -------------------------------------------- */
/*  Targeted roll confirmation                  */
/* -------------------------------------------- */

const rollContexts = [];
let rollDepth = 0;
let originalSetLastTargetedRoll = null;

function beginRollCapture(context) {
  const gurps = getGurps();
  if (!gurps || typeof gurps.setLastTargetedRoll !== 'function') return false;

  rollContexts.push(context);
  if (rollDepth === 0) {
    try {
      originalSetLastTargetedRoll = gurps.setLastTargetedRoll;
      gurps.setLastTargetedRoll = function (chatdata, ...args) {
        for (const active of rollContexts) {
          if (active.expectsPrompt && !active.promptHandled) continue;
          if (matchesAttackRoll(chatdata, active.attack)) active.rolled = true;
        }
        return originalSetLastTargetedRoll.apply(this, [chatdata, ...args]);
      };
    } catch (err) {
      rollContexts.pop();
      originalSetLastTargetedRoll = null;
      return false;
    }
  }
  rollDepth += 1;
  return true;
}

function endRollCapture(context) {
  const index = rollContexts.indexOf(context);
  if (index >= 0) rollContexts.splice(index, 1);
  rollDepth = Math.max(0, rollDepth - 1);
  if (rollDepth === 0 && originalSetLastTargetedRoll) {
    const gurps = getGurps();
    if (gurps) gurps.setLastTargetedRoll = originalSetLastTargetedRoll;
    originalSetLastTargetedRoll = null;
  }
}

/* -------------------------------------------- */
/*  Attack wrapper                              */
/* -------------------------------------------- */

function findMappedEntry(actor, itemId) {
  const sourceId = String(itemId ?? '');
  return getAmmoData(actor).entries.find(entry => String(entry.sourceId) === sourceId) ?? null;
}

async function handleAttack(originalAttack, thisArg, args) {
  const action = args?.action;
  const actor = args?.actor;
  const event = args?.event;

  if (!actor || !action || action.calcOnly) return originalAttack.call(thisArg, args);
  if (shouldRespectExternalAmmo(event)) return originalAttack.call(thisArg, args);

  const isMelee = !!action.isMelee;
  const isRanged = action.isRanged === undefined ? !isMelee : !!action.isRanged;
  if (isMelee || !isRanged || !action.name) return originalAttack.call(thisArg, args);

  const gurps = getGurps();
  if (typeof gurps?.findAttack !== 'function') return originalAttack.call(thisArg, args);

  await repairRangedAttackLevels(actor);

  let attack = null;
  try {
    attack = gurps.findAttack(actor.system, action.name, isMelee, isRanged);
  } catch (err) {
    return originalAttack.call(thisArg, args);
  }
  if (!attack) return originalAttack.call(thisArg, args);

  const item = findAmmoItemForAttack(actor, attack);
  const info = item ? getItemAmmoInfo(item) : null;
  if (item && !info) return originalAttack.call(thisArg, args);

  const autoCreate = getModuleSetting('autoCreateAmmo', true);
  let entry = item
    ? findMappedEntry(actor, item.id)
    : findRawAmmoEntryForAttack(actor, attack);
  if (!entry && !autoCreate) return originalAttack.call(thisArg, args);

  let entryState = entry ? getAmmoEntryState(actor, entry) : null;
  if (!entry || (!entryState?.tracker && !entryState?.linkedItem)) {
    if (!autoCreate) return originalAttack.call(thisArg, args);
    const entries = await ensureAmmoTrackers(actor, { create: true, cleanup: true });
    entry = item
      ? entries.find(itemEntry => String(itemEntry.sourceId) === String(item.id)) ?? findMappedEntry(actor, item.id)
      : findRawAmmoEntryForAttack(actor, attack);
    entryState = entry ? getAmmoEntryState(actor, entry) : null;
  }
  if (!entry || !entryState || (!entryState.tracker && !entryState.linkedItem)) return originalAttack.call(thisArg, args);

  const weaponName = String(item?.name ?? entry.name ?? attack.name ?? '');
  const available = Math.max(0, toInt(entryState.value, 0));
  if (available <= 0) {
    if (!getModuleSetting('blockWhenEmpty', true)) return originalAttack.call(thisArg, args);
    notify('warn', localize('GURPSITEMODERN.Ammo.NoAmmo', { weapon: weaponName }, 'Out of ammunition'));
    return false;
  }

  const originalRof = attack.rof;
  const baseMaxRoF = parseRateOfFire(originalRof);
  const effectiveMaxRoF = Math.max(1, Math.min(baseMaxRoF, available));
  let rofPatched = false;

  // Even if the shot prompt cannot be intercepted, temporarily cap RoF so GURPS
  // itself cannot offer more shots than the remaining ammunition.
  if (available < baseMaxRoF) {
    const suffix = String(originalRof ?? '').replace(/^\s*\d+/, '');
    attack.rof = `${available}${suffix}`;
    rofPatched = true;
  }

  const defaultSelected = 1;
  const context = {
    attack,
    actor,
    item,
    entry,
    maxRoF: effectiveMaxRoF,
    available,
    expectsPrompt: effectiveMaxRoF > 1 && available > 0,
    defaultSelected,
    selected: defaultSelected,
    promptHandled: false,
    rolled: false,
  };

  const beforeRoll = gurps.lastTargetedRoll;
  const promptCaptured = beginPromptCapture(context);
  if (!promptCaptured) context.expectsPrompt = false;
  beginRollCapture(context);

  let result;
  try {
    result = await originalAttack.call(thisArg, args);
  } finally {
    endPromptCapture(context);
    endRollCapture(context);
    if (rofPatched) attack.rof = originalRof;
  }

  if (!context.rolled && beforeRoll !== gurps.lastTargetedRoll && matchesAttackRoll(gurps.lastTargetedRoll, attack)) {
    context.rolled = true;
  }

  if (context.rolled) {
    await spendAmmo(actor, entry.sourceId, context.selected);
    refreshAmmoPanel(actor);
  }

  return result;
}

/**
 * Install the delegating action wrapper once.
 */
export function registerAmmoAttackHook() {
  registerPromptRenderHook();
  const funcs = getGurps()?.actionFuncs;
  if (!funcs || typeof funcs.attack !== 'function') {
    console.warn(`${MODULE_ID} | GURPS attack action was not found; ammunition spending is inactive.`);
    return;
  }
  if (funcs.attack.__gimAmmoWrapped) return;

  const original = funcs.attack;
  const wrapped = async function (args = {}) {
    return handleAttack(original, this, args);
  };
  Object.defineProperty(wrapped, '__gimAmmoWrapped', { value: true });
  funcs.attack = wrapped;
}


