/* Focus Checklist - intentionally dependency-free and offline-first. */
'use strict';

const DB_NAME = 'ChecklistDB';
const DB_VERSION = 5;
const TASK_STORE = 'tasks';
const CATEGORY_STORE = 'categories';
const SETTINGS_STORE = 'settings';
const DEFAULT_CATEGORIES = [
  { id: 'work', name: 'Work', color: '#2563eb', icon: '💼', builtIn: true },
  { id: 'congregation', name: 'Congregation', color: '#16a34a', icon: '👥', builtIn: true },
  { id: 'group', name: 'Group', color: '#7c3aed', icon: '👤', builtIn: true },
  { id: 'circuit-assembly', name: 'Circuit Assembly', color: '#ea580c', icon: '🏛️', builtIn: true },
  { id: 'convention', name: 'Convention', color: '#0f766e', icon: '📅', builtIn: true },
  { id: 'general', name: 'General', color: '#64748b', icon: '📌', builtIn: false, legacy: true },
  { id: 'personal', name: 'Personal', color: '#0891b2', icon: '🏠', builtIn: false, legacy: true },
  { id: 'urgent', name: 'Urgent', color: '#dc2626', icon: '⚠️', builtIn: false, legacy: true }
];

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

let db;
let currentView = 'today';
let categoryFilter = 'all';
let calendarCursor = new Date();
let selectedCalendarDate = toDateKey(new Date());
let focusTaskId = null;
let moveDateTaskId = null;
let newWorker = null;
let categoryCache = [];
let voiceLanguage = 'auto';
let activeRecognition = null;
let quickCategoryOverridden = false;
let quickDueOverridden = false;
let quickAutoCategory = '';
let quickAutoDue = '';
let selectionMode = false;
const selectedTaskIds = new Set();
let currentTodayFilter = 'today';

const els = {
  saveStatus: $('#save-status'),
  sidebar: $('#sidebar'),
  taskDialog: $('#task-dialog'),
  categoryDialog: $('#category-dialog'),
  focusModal: $('#focus-modal'),
  focusTask: $('#focus-task'),
  focusMeta: $('#focus-meta'),
  focusComplete: $('#focus-complete'),
  focusSkip: $('#focus-skip'),
  focusClose: $('#focus-close'),
  taskForm: $('#task-dialog-form'),
  quickTaskForm: $('#quick-task-form'),
  quickInput: $('#quick-task-input'),
  quickCategory: $('#quick-category'),
  quickDue: $('#quick-due'),
  quickPriority: $('#quick-priority'),
  globalSearch: $('#global-search'),
  statusFilter: $('#status-filter'),
  priorityFilter: $('#priority-filter'),
  dateFilter: $('#date-filter'),
  categoryNav: $('#category-nav'),
  todayGroups: $('#today-groups'),
  todayEmpty: $('#today-empty'),
  todaySummary: $('#today-summary'),
  progressLabel: $('#progress-label'),
  progressPercent: $('#progress-percent'),
  progressFill: $('#progress-fill'),
  todayDate: $('#today-date'),
  todaySearchWrap: $('#today-search-wrap'),
  todaySearch: $('#today-search'),
  tasksList: $('#tasks-list'),
  tasksEmpty: $('#tasks-empty'),
  calendarGrid: $('#calendar-grid'),
  calendarTasks: $('#calendar-tasks'),
  calendarTitle: $('#calendar-title'),
  settingsCategories: $('#settings-categories'),
  labelCategory: $('#label-category'),
  labelsList: $('#labels-list'),
  newLabelInput: $('#new-label-input'),
  backupStatus: $('#backup-status'),
  importFile: $('#import-file'),
  updateToast: $('#update-toast'),
  reloadBtn: $('#reload-btn')
};

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function nowISO() { return new Date().toISOString(); }
function toDateKey(date) {
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function fromDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function formatDate(dateOrKey, opts = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) {
  const date = typeof dateOrKey === 'string' ? fromDateKey(dateOrKey) : new Date(dateOrKey);
  return new Intl.DateTimeFormat(undefined, opts).format(date);
}
function isToday(key) { return key === toDateKey(new Date()); }
function isOverdue(task) { return Boolean(task.dueDate && task.dueDate < toDateKey(new Date()) && !task.completed); }
function dateLabel(key) {
  if (!key) return '';
  if (isToday(key)) return 'Today';
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  if (key === toDateKey(tomorrow)) return 'Tomorrow';
  return formatDate(key, { day: 'numeric', month: 'short', year: 'numeric' });
}
function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
}
function setSaveStatus(text = 'Saved on this device') {
  els.saveStatus.textContent = text;
  clearTimeout(setSaveStatus.timer);
  setSaveStatus.timer = setTimeout(() => { els.saveStatus.textContent = 'Saved on this device'; }, 1800);
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function transactionComplete(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const database = request.result;
      const oldVersion = event.oldVersion;

      if (!database.objectStoreNames.contains(TASK_STORE)) {
        database.createObjectStore(TASK_STORE, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(CATEGORY_STORE)) {
        database.createObjectStore(CATEGORY_STORE, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(SETTINGS_STORE)) {
        database.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
      }

      // IMPORTANT: Never delete the tasks store during a schema upgrade.
      // Existing task records are preserved and only missing fields are added.
      if (oldVersion < 5) {
        const taskStore = event.target.transaction.objectStore(TASK_STORE);
        const cursorRequest = taskStore.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const task = normalizeTask(cursor.value, cursor.key);
          cursor.update(task);
          cursor.continue();
        };
      }

      const categoryStore = event.target.transaction.objectStore(CATEGORY_STORE);
      for (const category of DEFAULT_CATEGORIES) categoryStore.put(category);
    };
    request.onsuccess = () => {
      db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error('Unable to open database'));
  });
}

function normalizeTask(raw = {}, fallbackId = uid()) {
  const legacyCategory = raw.category || 'general';
  const legacyUrgent = String(legacyCategory).toLowerCase() === 'urgent';
  return {
    ...raw,
    id: raw.id || fallbackId,
    text: String(raw.text || '').trim(),
    category: categoryIdFromLegacyName(legacyCategory),
    completed: Boolean(raw.completed || raw.status === 'completed'),
    status: raw.status || (raw.completed ? 'completed' : 'active'),
    priority: raw.priority || (legacyUrgent ? 'urgent' : 'normal'),
    subLabels: Array.isArray(raw.subLabels) ? raw.subLabels.map(String).filter(Boolean) : parseLabels(raw.labels || ''),
    notes: String(raw.notes || ''),
    waitingFor: String(raw.waitingFor || ''),
    followUpDate: raw.followUpDate || '',
    dueDate: raw.dueDate || '',
    reminderAt: raw.reminderAt || '',
    recurrence: raw.recurrence && ['daily','weekly','monthly','custom'].includes(raw.recurrence.frequency)
      ? { frequency: raw.recurrence.frequency, interval: Math.max(1, Number(raw.recurrence.interval) || 1), anchorDay: Math.min(31, Math.max(1, Number(raw.recurrence.anchorDay) || 0)) || null } : null,
    seriesId: raw.seriesId || '',
    occurrenceDate: raw.occurrenceDate || raw.dueDate || '',
    reminder: raw.reminder && ['at','1h','tomorrow'].includes(raw.reminder.type)
      ? { type: raw.reminder.type, time: raw.reminder.time || '09:00', notifications: Boolean(raw.reminder.notifications), at: raw.reminder.at || '', sentAt: raw.reminder.sentAt || '' }
      : (raw.reminderAt ? { type: 'at', time: '09:00', notifications: false, at: raw.reminderAt, sentAt: '' } : null),
    isDeleted: Boolean(raw.isDeleted),
    order: Number.isFinite(raw.order) ? raw.order : 0,
    createdAt: raw.createdAt || nowISO(),
    updatedAt: raw.updatedAt || nowISO()
  };
}
function categoryIdFromLegacyName(value) {
  const text = String(value || '').trim();
  const match = DEFAULT_CATEGORIES.find(c => c.id === text || c.name.toLowerCase() === text.toLowerCase());
  return match ? match.id : `legacy-${slugify(text) || 'category'}`;
}
function slugify(value) { return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g,''); }
function parseLabels(value) { return String(value || '').split(',').map(s => s.trim()).filter(Boolean); }

function parseNaturalQuickEntry(value, categories, now = new Date()) {
  const original = String(value || '').trim();
  if (!original) return { text: '', categoryId: '', dueDate: '', recognized: false };
  let text = original;
  let dueDate = '';
  const datePatterns = [
    /\b(today|tomorrow)\b/i,
    /\bin\s+(\d{1,3})\s+(days?|weeks?|months?)\b/i,
    /\bnext\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i,
    /\b(?:on\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i,
    /\b(\d{4}-\d{2}-\d{2})\b/
  ];
  for (const pattern of datePatterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const base = new Date(now); base.setHours(12, 0, 0, 0);
    const phrase = match[0].toLowerCase();
    if (phrase === 'today') dueDate = toDateKey(base);
    else if (phrase === 'tomorrow') { base.setDate(base.getDate() + 1); dueDate = toDateKey(base); }
    else if (/^in\s+/.test(phrase)) {
      const amount = Number(match[1]);
      const unit = match[2].toLowerCase();
      if (unit.startsWith('day')) base.setDate(base.getDate() + amount);
      else if (unit.startsWith('week')) base.setDate(base.getDate() + amount * 7);
      else {
        const day = base.getDate(); base.setDate(1); base.setMonth(base.getMonth() + amount);
        base.setDate(Math.min(day, new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate()));
      }
      dueDate = toDateKey(base);
    } else if (/^(?:(?:next|on)\s+)?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.test(phrase)) {
      const weekday = phrase.replace(/^(next\s+|on\s+)/, '').split(/\s+/).pop();
      const names = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
      let offset = (names.indexOf(weekday) - base.getDay() + 7) % 7;
      if (phrase.startsWith('next ')) offset = offset ? offset + 7 : 7;
      else if (offset === 0) offset = 7;
      base.setDate(base.getDate() + offset); dueDate = toDateKey(base);
    } else {
      const candidate = fromDateKey(match[1]);
      if (toDateKey(candidate) === match[1]) dueDate = match[1];
    }
    if (dueDate) { text = `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`.replace(/\s+/g, ' ').replace(/^[\s,.;:!?-]+|[\s,.;:!?-]+$/g, '').trim(); break; }
  }

  let categoryId = '';
  const sorted = [...(categories || [])].sort((a, b) => String(b.name).length - String(a.name).length);
  for (const category of sorted) {
    const escaped = String(category.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const expression = new RegExp(`\\b${escaped}\\b`, 'i');
    const explicitPrefix = new RegExp(`^\\s*${escaped}\\s*:\\s*`, 'i');
    if (expression.test(text)) {
      categoryId = category.id;
      text = text.replace(explicitPrefix, '').trim();
      break;
    }
  }
  return { text: text || original, categoryId, dueDate, recognized: Boolean(categoryId || dueDate) };
}

function getAllTasksRaw() {
  const tx = db.transaction(TASK_STORE, 'readonly');
  return requestToPromise(tx.objectStore(TASK_STORE).getAll());
}
async function getAllTasks() {
  const all = await getAllTasksRaw();
  return all.map(t => normalizeTask(t, t.id)).filter(t => !t.isDeleted).sort((a,b) => (a.order ?? 0) - (b.order ?? 0));
}
async function upsertTask(task) {
  const safe = normalizeTask(task, task.id);
  safe.updatedAt = nowISO();
  const tx = db.transaction(TASK_STORE, 'readwrite');
  tx.objectStore(TASK_STORE).put(safe);
  await transactionComplete(tx);
  setSaveStatus();
  return safe;
}
async function addTask(task) { return upsertTask(task); }
async function softDeleteTask(task) { return upsertTask({ ...task, isDeleted: true }); }

function getCategories() {
  const tx = db.transaction(CATEGORY_STORE, 'readonly');
  return requestToPromise(tx.objectStore(CATEGORY_STORE).getAll()).then(list => list.sort((a,b) => {
    if (a.builtIn !== b.builtIn) return a.builtIn ? -1 : 1;
    return a.name.localeCompare(b.name);
  }));
}
async function saveCategory(category) {
  const tx = db.transaction(CATEGORY_STORE, 'readwrite');
  tx.objectStore(CATEGORY_STORE).put(category);
  await transactionComplete(tx);
  setSaveStatus();
}
async function deleteCategory(categoryId) {
  const tasks = await getAllTasks();
  if (tasks.some(t => t.category === categoryId)) {
    throw new Error('This category still has tasks. Reassign them before deleting it.');
  }
  const category = (await getCategories()).find(c => c.id === categoryId);
  if (!category || category.builtIn) throw new Error('Built-in categories cannot be deleted.');
  const tx = db.transaction(CATEGORY_STORE, 'readwrite');
  tx.objectStore(CATEGORY_STORE).delete(categoryId);
  await transactionComplete(tx);
}
function getSetting(key, fallback) {
  const tx = db.transaction(SETTINGS_STORE, 'readonly');
  return requestToPromise(tx.objectStore(SETTINGS_STORE).get(key)).then(row => row ? row.value : fallback);
}
async function saveSetting(key, value) {
  const tx = db.transaction(SETTINGS_STORE, 'readwrite');
  tx.objectStore(SETTINGS_STORE).put({ key, value });
  await transactionComplete(tx);
  setSaveStatus();
}

async function ensureLegacyCategories(tasks) {
  const categories = await getCategories();
  const existingIds = new Set(categories.map(c => c.id));
  for (const task of tasks) {
    if (task.category && !existingIds.has(task.category)) {
      await saveCategory({ id: task.category, name: task.category.replace(/^legacy-/,'').replace(/-/g,' '), color: '#64748b', icon:'📌', builtIn:false, legacy:true });
      existingIds.add(task.category);
    }
  }
}

async function populateCategoryControls() {
  const categories = await getCategories();
  categoryCache = categories;
  const currentQuick = els.quickCategory.value;
  const currentDialog = $('#dialog-task-category').value;
  const currentLabel = els.labelCategory.value;
  const currentTemplate = $('#template-category').value;
  const options = categories.map(c => `<option value="${escapeHTML(c.id)}">${escapeHTML(c.icon)} ${escapeHTML(c.name)}</option>`).join('');
  els.quickCategory.innerHTML = options;
  $('#dialog-task-category').innerHTML = options;
  els.labelCategory.innerHTML = options;
  $('#template-category').innerHTML = options;
  const currentBulk = $('#bulk-category').value;
  $('#bulk-category').innerHTML = `<option value="all">Keep categories</option>${options}`;
  if ([...$('#bulk-category').options].some(option => option.value === currentBulk)) $('#bulk-category').value = currentBulk;
  if ([...els.quickCategory.options].some(o => o.value === currentQuick)) els.quickCategory.value = currentQuick; else els.quickCategory.value = categories[0]?.id || '';
  if ([...$('#dialog-task-category').options].some(o => o.value === currentDialog)) $('#dialog-task-category').value = currentDialog;
  if ([...els.labelCategory.options].some(o => o.value === currentLabel)) els.labelCategory.value = currentLabel; else els.labelCategory.value = categories[0]?.id || '';
  if ([...$('#template-category').options].some(o => o.value === currentTemplate)) $('#template-category').value = currentTemplate; else $('#template-category').value = categories[0]?.id || '';
  updateQuickParsePreview();

  els.categoryNav.innerHTML = `<button type="button" data-category-filter="all"><span class="category-dot" style="background:#334155"></span><span>All categories</span></button>` + categories.map(c => `<button type="button" data-category-filter="${escapeHTML(c.id)}"><span class="category-dot" style="background:${escapeHTML(c.color)}"></span><span>${escapeHTML(c.name)}</span></button>`).join('');
  $$('#category-nav button').forEach(btn => btn.addEventListener('click', () => {
    categoryFilter = btn.dataset.categoryFilter;
    openView('tasks');
    renderTasks();
    if (els.sidebar) els.sidebar.classList.remove('menu-open');
  }));
}

async function renderSettings() {
  const categories = await getCategories();
  els.settingsCategories.innerHTML = categories.map(c => `
    <div class="category-setting-row">
      <span class="category-dot" style="background:${escapeHTML(c.color)}"></span>
      <div><div class="category-name">${escapeHTML(c.icon)} ${escapeHTML(c.name)}</div><div class="fine-print">${c.builtIn ? 'Built-in category' : 'Custom category'}</div></div>
      <div class="category-actions">
        ${c.builtIn ? '' : `<button class="task-action edit-category" data-id="${escapeHTML(c.id)}" title="Edit category" aria-label="Edit category">✎</button><button class="task-action delete-category" data-id="${escapeHTML(c.id)}" title="Delete category" aria-label="Delete category">🗑</button>`}
      </div>
    </div>`).join('');
  $$('.edit-category').forEach(btn => btn.addEventListener('click', () => openCategoryDialog(btn.dataset.id)));
  $$('.delete-category').forEach(btn => btn.addEventListener('click', async () => {
    try { await deleteCategory(btn.dataset.id); await refreshAll(); } catch (err) { alert(err.message); }
  }));
  await renderLabels();
  await renderTemplates();
}

async function renderTemplates() {
  const templates = await getSetting('taskTemplates', []);
  const safeTemplates = Array.isArray(templates) ? templates.filter(template => template && template.id && template.name && Array.isArray(template.tasks)) : [];
  const categories = new Map((await getCategories()).map(c => [c.id, c]));
  const container = $('#template-list');
  if (!safeTemplates.length) {
    container.innerHTML = '<p class="fine-print">No templates saved yet. Create one above to reuse a group of tasks.</p>';
    return;
  }
  container.innerHTML = safeTemplates.map(template => {
    const category = categories.get(template.category) || { name: 'Default category', icon: '📌' };
    const firstItems = template.tasks.slice(0, 3).map(task => `<li>${escapeHTML(task)}</li>`).join('');
    const remaining = template.tasks.length > 3 ? `<li class="fine-print">and ${template.tasks.length - 3} more…</li>` : '';
    return `<article class="template-card" data-template-id="${escapeHTML(template.id)}"><div class="template-card-head"><div><h4>${escapeHTML(template.name)}</h4><p>${escapeHTML(category.icon)} ${escapeHTML(category.name)} · ${template.tasks.length} tasks</p></div><button type="button" class="task-action delete-template" data-id="${escapeHTML(template.id)}" aria-label="Delete template ${escapeHTML(template.name)}" title="Delete template">🗑</button></div><ul>${firstItems}${remaining}</ul><button type="button" class="secondary-btn template-use" data-id="${escapeHTML(template.id)}">Add these tasks</button></article>`;
  }).join('');
  $$('.template-use').forEach(button => button.addEventListener('click', () => addTemplateTasks(button.dataset.id, button)));
  $$('.delete-template').forEach(button => button.addEventListener('click', () => deleteTemplate(button.dataset.id)));
}

async function saveTemplate(event) {
  event.preventDefault();
  const name = $('#template-name').value.trim();
  const tasks = $('#template-tasks').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!name || !tasks.length) return;
  const saved = await getSetting('taskTemplates', []);
  const templates = Array.isArray(saved) ? saved.filter(template => template && typeof template.name === 'string' && Array.isArray(template.tasks)) : [];
  if (templates.some(template => template.name.toLowerCase() === name.toLowerCase())) {
    $('#template-status').textContent = 'A template already has that name. Choose a different name.';
    return;
  }
  templates.push({ id: uid(), name, category: $('#template-category').value, tasks, createdAt: nowISO() });
  await saveSetting('taskTemplates', templates);
  $('#template-name').value = '';
  $('#template-tasks').value = '';
  $('#template-status').textContent = `Saved “${name}”.`;
  await renderTemplates();
}

async function deleteTemplate(templateId) {
  const saved = await getSetting('taskTemplates', []);
  const templates = Array.isArray(saved) ? saved : [];
  const template = templates.find(item => item.id === templateId);
  if (!template || !confirm(`Delete the “${template.name}” template? Existing tasks will stay in your list.`)) return;
  await saveSetting('taskTemplates', templates.filter(item => item.id !== templateId));
  $('#template-status').textContent = `Deleted “${template.name}”.`;
  await renderTemplates();
}

async function addTemplateTasks(templateId, button) {
  if (button.disabled) return;
  button.disabled = true;
  const saved = await getSetting('taskTemplates', []);
  const templates = Array.isArray(saved) ? saved : [];
  const template = templates.find(item => item.id === templateId);
  if (!template) { button.disabled = false; return; }
  try {
    const [existing, categories] = await Promise.all([getAllTasks(), getCategories()]);
    const categoryId = categories.some(category => category.id === template.category) ? template.category : (categories[0]?.id || 'general');
    const now = nowISO();
    const tx = db.transaction(TASK_STORE, 'readwrite');
    const store = tx.objectStore(TASK_STORE);
    const done = transactionComplete(tx);
    template.tasks.forEach((text, index) => store.add(normalizeTask({
      id: uid(), text, category: categoryId, priority: 'normal', status: 'active', completed: false,
      dueDate: '', recurrence: null, seriesId: '', reminder: null, reminderAt: '',
      isDeleted: false, order: existing.length + index, createdAt: now, updatedAt: now
    })));
    await done;
    setSaveStatus(`${template.tasks.length} tasks added`);
    $('#template-status').textContent = `Added ${template.tasks.length} tasks from “${template.name}”.`;
    await refreshAll();
  } catch (error) {
    console.error('Template task creation failed:', error);
    alert('The template tasks could not be added. Please try again.');
  } finally {
    button.disabled = false;
  }
}
async function renderLabels() {
  const categoryId = els.labelCategory.value;
  const labels = await getSetting(`labels:${categoryId}`, []);
  els.labelsList.innerHTML = labels.length ? labels.map(label => `<span class="chip">${escapeHTML(label)}<button type="button" data-label="${escapeHTML(label)}" aria-label="Remove label ${escapeHTML(label)}">×</button></span>`).join('') : '<span class="fine-print">No reusable sub-labels yet.</span>';
  $$('#labels-list .chip button').forEach(btn => btn.addEventListener('click', async () => {
    const current = await getSetting(`labels:${categoryId}`, []);
    await saveSetting(`labels:${categoryId}`, current.filter(v => v !== btn.dataset.label));
    renderLabels();
  }));
}

function taskForDisplay(task, categoriesMap) {
  return { task, category: categoriesMap.get(task.category) || { id:task.category, name:task.category, color:'#64748b', icon:'📌' } };
}
function statusLabel(status) { return ({active:'Not started','in-progress':'In progress',waiting:'Waiting',completed:'Completed'})[status] || 'Not started'; }
function priorityLabel(priority) { return ({normal:'Normal',important:'Important',urgent:'Urgent'})[priority] || 'Normal'; }
function duePill(task) {
  if (!task.dueDate) return '';
  const cls = isOverdue(task) ? 'overdue' : (isToday(task.dueDate) ? 'today' : '');
  const text = isOverdue(task) ? `Overdue · ${dateLabel(task.dueDate)}` : dateLabel(task.dueDate);
  return `<span class="due-pill ${cls}">📅 ${escapeHTML(text)}</span>`;
}

function renderTaskCard(task, categoriesMap) {
  const { category } = taskForDisplay(task, categoriesMap);
  const labels = (task.subLabels || []).map(l => `<span class="label-pill">${escapeHTML(l)}</span>`).join('');
  const waiting = task.waitingFor ? `<span class="label-pill">Waiting for ${escapeHTML(task.waitingFor)}${task.followUpDate ? ` · follow up ${escapeHTML(dateLabel(task.followUpDate))}` : ''}</span>` : '';
  const notes = task.notes ? `<div class="task-notes-preview">${escapeHTML(task.notes)}</div>` : '';
  const recurrence = task.recurrence ? '<span class="label-pill" title="Repeats when completed">↻ Repeats</span>' : '';
  const reminder = task.reminder ? '<span class="label-pill" title="Reminder set">🔔 Reminder</span>' : '';
  return `<article class="task-card ${task.completed ? 'completed' : ''} ${selectionMode ? 'selection-mode' : ''}" data-id="${escapeHTML(task.id)}">
    <input class="task-select ${selectionMode ? '' : 'hidden'}" type="checkbox" ${selectedTaskIds.has(task.id) ? 'checked' : ''} aria-label="Select ${escapeHTML(task.text)}">
    <input class="task-check" type="checkbox" ${task.completed ? 'checked' : ''} aria-label="Mark ${escapeHTML(task.text)} ${task.completed ? 'not done' : 'done'}">
    <div class="task-main">
      <div class="task-title-row"><span class="task-title">${escapeHTML(task.text)}</span><span class="category-pill" style="background:${escapeHTML(category.color)}">${escapeHTML(category.icon)} ${escapeHTML(category.name)}</span></div>
      <div class="task-meta"><span class="status-pill ${escapeHTML(task.status)}">${escapeHTML(statusLabel(task.status))}</span><span class="priority-pill ${escapeHTML(task.priority)}">${escapeHTML(priorityLabel(task.priority))}</span>${duePill(task)}${recurrence}${reminder}${labels}${waiting}</div>
      ${notes}
    </div>
    <div class="task-action-col"><details class="task-more"><summary class="task-action" aria-label="More actions for ${escapeHTML(task.text)}" title="More actions">•••</summary><div class="task-more-menu"><button type="button" class="task-more-action move-tomorrow">Move to tomorrow</button><button type="button" class="task-more-action move-date">Choose a date…</button><button type="button" class="task-more-action duplicate-task">Duplicate</button><button type="button" class="task-more-action edit-task">Edit / change category</button><button type="button" class="task-more-action delete-task">Delete</button></div></details></div>
  </article>`;
}
function wireTaskCards(root) {
  root.querySelectorAll('.task-card').forEach(card => {
    const taskId = card.dataset.id;
    card.querySelector('.task-select')?.addEventListener('change', event => { event.target.checked ? selectedTaskIds.add(taskId) : selectedTaskIds.delete(taskId); updateBulkToolbar(); });
    card.querySelector('.task-check')?.addEventListener('change', async (e) => {
      const tasks = await getAllTasks();
      const task = tasks.find(t => t.id === taskId);
      if (!task) return;
      task.completed = e.target.checked;
      task.status = task.completed ? 'completed' : 'active';
      await upsertTask(task);
      if (task.completed) await createNextOccurrence(task);
      await refreshAll();
    });
    card.querySelector('.edit-task')?.addEventListener('click', () => openTaskDialog(taskId));
    card.querySelector('.move-tomorrow')?.addEventListener('click', () => moveTaskToTomorrow(taskId));
    card.querySelector('.move-date')?.addEventListener('click', () => chooseTaskDate(taskId));
    card.querySelector('.duplicate-task')?.addEventListener('click', () => duplicateTask(taskId));
    card.querySelector('.delete-task')?.addEventListener('click', async () => {
      const tasks = await getAllTasks();
      const task = tasks.find(t => t.id === taskId);
      if (!task) return;
      if (!confirm(`Delete “${task.text}”?`)) return;
      await softDeleteTask(task);
      await refreshAll();
    });
  });
}
function groupTasks(tasks, categoriesMap) {
  const groups = [];
  const map = new Map();
  tasks.forEach(task => {
    const { category } = taskForDisplay(task, categoriesMap);
    if (!map.has(category.id)) { const group = { category, tasks: [] }; map.set(category.id, group); groups.push(group); }
    map.get(category.id).tasks.push(task);
  });
  return groups;
}
function renderGroups(container, tasks, categoriesMap) {
  container.innerHTML = '';
  for (const group of groupTasks(tasks, categoriesMap)) {
    const wrapper = document.createElement('section');
    wrapper.className = 'task-group';
    wrapper.style.setProperty('--group-color', group.category.color);
    wrapper.innerHTML = `<div class="task-group-header"><div class="group-title"><span>${escapeHTML(group.category.icon)}</span><span>${escapeHTML(group.category.name)}</span></div><span class="group-count">${group.tasks.length} task${group.tasks.length === 1 ? '' : 's'}</span></div><div class="task-cards">${group.tasks.map(t => renderTaskCard(t, categoriesMap)).join('')}</div>`;
    container.appendChild(wrapper);
    wireTaskCards(wrapper);
  }
}

async function renderToday() {
  const [tasks, categories] = await Promise.all([getAllTasks(), getCategories()]);
  const categoriesMap = new Map(categories.map(c => [c.id,c]));
  els.todayDate.textContent = formatDate(new Date());
  const todayKey = toDateKey(new Date());
  const doneToday = tasks.filter(t => t.completed && (t.dueDate === todayKey || !t.dueDate)).length;
  const activeToday = tasks.filter(t => !t.completed && (t.dueDate === todayKey || isOverdue(t))).length;
  els.todaySummary.textContent = `${activeToday} ${activeToday === 1 ? 'task' : 'tasks'} need attention${doneToday ? ` · ${doneToday} completed` : ''}`;

  const nonDeleted = tasks;
  const total = nonDeleted.length;
  const completed = nonDeleted.filter(t => t.completed).length;
  const percent = total ? Math.round(completed / total * 100) : 0;
  els.progressLabel.textContent = `${completed} of ${total} complete`;
  els.progressPercent.textContent = `${percent}%`;
  els.progressFill.style.width = `${percent}%`;

  const search = (els.todaySearch.value || '').trim().toLowerCase();
  let filtered = tasks.filter(task => {
    const relevantToday = task.dueDate ? (task.dueDate <= todayKey && !task.completed) : !task.completed;
    if (currentTodayFilter === 'important' && task.priority === 'normal') return false;
    if (currentTodayFilter === 'waiting' && task.status !== 'waiting') return false;
    if (currentTodayFilter === 'overdue' && !isOverdue(task)) return false;
    if (currentTodayFilter === 'upcoming' && (!task.dueDate || task.dueDate <= todayKey || task.completed)) return false;
    if (currentTodayFilter === 'today' && !relevantToday && !isToday(task.dueDate)) return false;
    if (search && !taskSearchable(task).includes(search)) return false;
    return true;
  });
  if (currentTodayFilter === 'today' || currentTodayFilter === 'overdue' || currentTodayFilter === 'upcoming') filtered = filtered.sort((a,b) => taskAttentionScore(a) - taskAttentionScore(b));
  renderGroups(els.todayGroups, filtered, categoriesMap);
  els.todayEmpty.classList.toggle('hidden', filtered.length > 0);
  renderTodaySummary(tasks, categories);
}
function taskAttentionScore(task) {
  let score = 0;
  if (task.completed) score += 1000;
  if (isOverdue(task)) score -= 100;
  if (isToday(task.dueDate)) score -= 50;
  if (task.priority === 'urgent') score -= 20;
  else if (task.priority === 'important') score -= 10;
  return score + (task.order ?? 0);
}
function categorySearchable(task, categories = categoryCache) { const category = categories.find(item => item.id === task.category); return `${task.category} ${category?.name || ''}`.toLowerCase(); }
function taskSearchable(task, categories = categoryCache) { const category = categories.find(item => item.id === task.category); return [task.text, task.notes, task.category, category?.name, task.waitingFor, task.dueDate, statusLabel(task.status), priorityLabel(task.priority), ...(task.subLabels || [])].join(' ').toLowerCase(); }
function matchesTaskQuery(task, query) {
  const tokens = query.toLowerCase().match(/(?:[\w-]+:"[^"]+"|"[^"]+"|\S+)/g) || [];
  const plain = [];
  for (const token of tokens) {
    const value = token.replace(/^"|"$/g, '');
    if (value.startsWith('category:')) { const categoryNeedle = value.slice(9).replace(/^"|"$/g, ''); if (!categorySearchable(task).includes(categoryNeedle)) return false; }
    else if (value.startsWith('label:')) { if (!(task.subLabels || []).some(label => label.toLowerCase().includes(value.slice(6).replace(/^"|"$/g, '')))) return false; }
    else if (value === 'is:waiting') { if (task.status !== 'waiting') return false; }
    else if (value === 'is:completed') { if (!task.completed) return false; }
    else if (value === 'is:overdue') { if (!isOverdue(task)) return false; }
    else if (value === 'due:today') { if (!isToday(task.dueDate)) return false; }
    else if (value === 'due:upcoming') { if (!task.dueDate || task.dueDate <= toDateKey(new Date()) || task.completed) return false; }
    else if (value === 'due:overdue') { if (!isOverdue(task)) return false; }
    else if (value === 'due:none') { if (task.dueDate) return false; }
    else if (value.startsWith('status:')) { if (task.status !== value.slice(7)) return false; }
    else if (value.startsWith('priority:')) { if (task.priority !== value.slice(9)) return false; }
    else if (value.includes(':')) plain.push(value);
    else plain.push(value);
  }
  const searchable = taskSearchable(task);
  return plain.every(word => searchable.includes(word));
}

async function renderTasks() {
  const [tasks, categories] = await Promise.all([getAllTasks(), getCategories()]);
  const categoriesMap = new Map(categories.map(c => [c.id,c]));
  const q = (els.globalSearch.value || '').trim().toLowerCase();
  let filtered = tasks.filter(task => {
    if (categoryFilter !== 'all' && task.category !== categoryFilter) return false;
    if (q && !matchesTaskQuery(task, q)) return false;
    const dateFilter = els.dateFilter.value;
    const today = toDateKey(new Date());
    if (dateFilter === 'overdue' && !isOverdue(task)) return false;
    if (dateFilter === 'today' && !isToday(task.dueDate)) return false;
    if (dateFilter === 'upcoming' && (!task.dueDate || task.dueDate <= today || task.completed)) return false;
    if (dateFilter === 'no-date' && task.dueDate) return false;
    if (els.statusFilter.value !== 'all') {
      if (els.statusFilter.value === 'active' && task.status !== 'active') return false;
      if (els.statusFilter.value !== 'active' && task.status !== els.statusFilter.value) return false;
    }
    if (els.priorityFilter.value !== 'all' && task.priority !== els.priorityFilter.value) return false;
    return true;
  });
  filtered.sort((a,b) => taskAttentionScore(a) - taskAttentionScore(b));
  renderGroups(els.tasksList, filtered, categoriesMap);
  els.tasksEmpty.classList.toggle('hidden', filtered.length > 0);
  updateBulkToolbar();
}

function renderTodaySummary(tasks, categories) {
  const key = toDateKey(new Date());
  const active = tasks.filter(task => !task.completed);
  const counts = { overdue: active.filter(isOverdue).length, today: active.filter(task => isToday(task.dueDate)).length, upcoming: active.filter(task => task.dueDate > key).length };
  $('#today-counts').innerHTML = [['overdue','Overdue'],['today','Due today'],['upcoming','Upcoming']].map(([filter,label]) => `<button class="today-count ${currentTodayFilter === filter ? 'selected' : ''}" type="button" data-count-filter="${filter}"><strong>${counts[filter]}</strong><span>${label}</span></button>`).join('');
  $$('#today-counts [data-count-filter]').forEach(button => button.addEventListener('click', () => { currentTodayFilter = button.dataset.countFilter; $$('.segment-btn[data-today-filter]').forEach(item => item.classList.remove('active')); renderToday(); }));
  const next = active.filter(task => task.status !== 'waiting').sort((a,b) => taskAttentionScore(a) - taskAttentionScore(b))[0];
  const card = $('#next-task-card');
  card.classList.toggle('hidden', !next);
  if (next) {
    const category = categories.find(item => item.id === next.category);
    $('#next-task-title').textContent = next.text;
    $('#next-task-meta').textContent = `${category?.icon || '📌'} ${category?.name || next.category} · ${priorityLabel(next.priority)}${next.dueDate ? ` · ${dateLabel(next.dueDate)}` : ''}${next.waitingFor ? ` · Waiting for ${next.waitingFor}` : ''}`;
    $('#next-task-focus').onclick = openFocusMode;
  }
}

async function renderWaiting() {
  const [tasks, categories] = await Promise.all([getAllTasks(), getCategories()]);
  const waiting = tasks.filter(task => task.status === 'waiting' && !task.completed).sort((a,b) => (a.followUpDate || '9999').localeCompare(b.followUpDate || '9999'));
  renderGroups($('#waiting-list'), waiting, new Map(categories.map(category => [category.id, category])));
  $('#waiting-empty').classList.toggle('hidden', waiting.length > 0);
}

async function moveTaskToTomorrow(id) {
  const task = (await getAllTasks()).find(item => item.id === id); if (!task) return;
  const date = new Date(); date.setDate(date.getDate() + 1); setTaskDueDate(task, toDateKey(date)); await upsertTask(task); await refreshAll();
}
function setTaskDueDate(task, dueDate) {
  task.dueDate = dueDate;
  if (task.reminder) {
    task.reminder.sentAt = '';
    if (['at','tomorrow'].includes(task.reminder.type)) {
      task.reminder.at = dueDate ? new Date(`${dueDate}T${task.reminder.time || '09:00'}:00`).toISOString() : '';
    }
    task.reminderAt = task.reminder.at || '';
  } else task.reminderAt = '';
  task.updatedAt = nowISO();
}
async function chooseTaskDate(id) {
  const task = (await getAllTasks()).find(item => item.id === id); if (!task) return;
  moveDateTaskId = id;
  $('#move-date-value').value = task.dueDate || toDateKey(new Date());
  $('#move-date-dialog').showModal();
}
async function saveMovedTaskDate(event) {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') { $('#move-date-dialog').close(); moveDateTaskId = null; return; }
  const task = (await getAllTasks()).find(item => item.id === moveDateTaskId); if (!task) { $('#move-date-dialog').close(); return; }
  setTaskDueDate(task, $('#move-date-value').value);
  await upsertTask(task); $('#move-date-dialog').close(); moveDateTaskId = null; await refreshAll();
}
async function duplicateTask(id) {
  const original = (await getAllTasks()).find(item => item.id === id); if (!original) return;
  const copy = normalizeTask({ ...original, id: uid(), text: `${original.text} (copy)`, completed: false, status: 'active', recurrence: null, seriesId: '', occurrenceDate: original.dueDate || '', reminder: null, reminderAt: '', isDeleted: false, createdAt: nowISO(), updatedAt: nowISO() });
  await upsertTask(copy); await refreshAll();
}

function updateBulkToolbar() {
  const toolbar = $('#bulk-toolbar');
  toolbar.classList.toggle('hidden', !selectionMode);
  if (!selectionMode) {
    $('#bulk-complete').dataset.active = 'false';
    $('#bulk-complete').classList.remove('selected');
    $('#bulk-complete').textContent = 'Complete';
  }
  $('#selection-mode-btn').setAttribute('aria-pressed', String(selectionMode));
  $('#selection-mode-btn').textContent = selectionMode ? 'Done selecting' : 'Select tasks';
  $('#selection-count').textContent = `${selectedTaskIds.size} selected`;
}
async function applyBulkChanges() {
  if (!selectedTaskIds.size) return;
  const ids = new Set(selectedTaskIds);
  const date = $('#bulk-date').value;
  const category = $('#bulk-category').value;
  const complete = $('#bulk-complete').dataset.active === 'true';
  const tasks = await getAllTasks();
  const tx = db.transaction(TASK_STORE, 'readwrite'); const store = tx.objectStore(TASK_STORE); const done = transactionComplete(tx);
  const changedTasks = tasks.filter(task => ids.has(task.id));
  changedTasks.forEach(task => {
    if (complete) { task.completed = true; task.status = 'completed'; }
    if (date) setTaskDueDate(task, date);
    if (category && category !== 'all') task.category = category;
    task.updatedAt = nowISO(); store.put(task);
  });
  await done;
  if (complete) for (const task of changedTasks) await createNextOccurrence({ ...task, completed: true, status: 'completed' });
  selectedTaskIds.clear(); selectionMode = false; $('#bulk-date').value = ''; $('#bulk-complete').dataset.active = 'false'; await refreshAll();
}

function monthMatrix(date) {
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const startDay = first.getDay();
  const start = new Date(first); start.setDate(first.getDate() - startDay);
  return Array.from({length:42}, (_, i) => { const d = new Date(start); d.setDate(start.getDate()+i); return d; });
}
async function renderCalendar() {
  const [tasks, categories] = await Promise.all([getAllTasks(), getCategories()]);
  const categoryMap = new Map(categories.map(c => [c.id,c]));
  els.calendarTitle.textContent = formatDate(calendarCursor, {month:'long', year:'numeric'});
  const days = monthMatrix(calendarCursor);
  const headings = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => `<div class="calendar-day-heading">${d}</div>`).join('');
  const cells = days.map(day => {
    const key = toDateKey(day);
    const dayTasks = tasks.filter(t => t.dueDate === key);
    const dots = dayTasks.slice(0,5).map(t => `<span class="day-dot" title="${escapeHTML(t.text)}" style="background:${escapeHTML((categoryMap.get(t.category)||{}).color||'#64748b')}"></span>`).join('');
    return `<button class="calendar-day ${day.getMonth() !== calendarCursor.getMonth() ? 'outside':''} ${selectedCalendarDate === key ? 'selected':''}" type="button" data-date="${key}"><div class="day-number">${day.getDate()}</div><div class="day-dots">${dots}</div></button>`;
  }).join('');
  els.calendarGrid.innerHTML = headings + cells;
  $$('.calendar-day').forEach(btn => btn.addEventListener('click', async () => { selectedCalendarDate = btn.dataset.date; await renderCalendar(); }));
  const selected = tasks.filter(t => t.dueDate === selectedCalendarDate);
  els.calendarTasks.innerHTML = `<div class="task-group"><div class="task-group-header"><div class="group-title"><span>📅</span><span>${escapeHTML(dateLabel(selectedCalendarDate) || formatDate(selectedCalendarDate))}</span></div><span class="group-count">${selected.length} task${selected.length === 1 ? '' : 's'}</span></div><div class="task-cards">${selected.length ? selected.map(t => renderTaskCard(t, categoryMap)).join('') : '<div class="empty-state"><h3>No tasks on this date</h3><p>Add one from Quick Add.</p></div>'}</div></div>`;
  wireTaskCards(els.calendarTasks);
}

function openView(view) {
  currentView = view;
  $$('.view').forEach(panel => panel.classList.toggle('active-view', panel.dataset.viewPanel === view));
  $$('.nav-btn[data-view]').forEach(btn => btn.classList.toggle('active', btn.dataset.view === view));
  els.sidebar?.classList.remove('menu-open');
  if (view === 'today') renderToday();
  if (view === 'tasks') renderTasks();
  if (view === 'waiting') renderWaiting();
  if (view === 'waiting') renderWaiting();
  if (view === 'calendar') renderCalendar();
  if (view === 'settings') renderSettings();
}

function resetTaskDialog() {
  els.taskForm.reset();
  $('#edit-task-id').value = '';
  $('#task-dialog-title').textContent = 'Add task';
  $('#dialog-task-priority').value = 'normal';
  $('#dialog-task-status').value = 'active';
  $('#dialog-task-repeat').value = 'none';
  $('#dialog-task-repeat-interval').value = '2';
  $('#dialog-task-reminder').value = 'none';
  $('#dialog-task-reminder-time').value = '09:00';
  $('#dialog-task-notification').checked = false;
  $('#repeat-interval-field').classList.add('hidden');
  $('#reminder-time-field').classList.add('hidden');
  $('#delete-task-dialog').classList.add('hidden');
  $('#notes-voice-status').classList.add('hidden');
}
async function openTaskDialog(taskId = null, preset = {}) {
  resetTaskDialog();
  await populateCategoryControls();
  if (taskId) {
    const tasks = await getAllTasks();
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    $('#task-dialog-title').textContent = 'Edit task';
    $('#edit-task-id').value = task.id;
    $('#dialog-task-text').value = task.text;
    $('#dialog-task-category').value = task.category;
    $('#dialog-task-priority').value = task.priority;
    $('#dialog-task-status').value = task.status;
    $('#dialog-task-due').value = task.dueDate || '';
    $('#dialog-task-labels').value = (task.subLabels || []).join(', ');
    $('#dialog-task-waiting').value = task.waitingFor || '';
    $('#dialog-task-followup').value = task.followUpDate || '';
    $('#dialog-task-notes').value = task.notes || '';
    $('#dialog-task-repeat').value = task.recurrence?.frequency || 'none';
    $('#dialog-task-repeat-interval').value = task.recurrence?.interval || 2;
    $('#dialog-task-reminder').value = task.reminder?.type || 'none';
    $('#dialog-task-reminder-time').value = task.reminder?.time || '09:00';
    $('#dialog-task-notification').checked = Boolean(task.reminder?.notifications);
    $('#repeat-interval-field').classList.toggle('hidden', !task.recurrence || task.recurrence.frequency !== 'custom');
    $('#reminder-time-field').classList.toggle('hidden', !task.reminder || task.reminder.type === '1h');
    $('#delete-task-dialog').classList.remove('hidden');
  } else {
    $('#dialog-task-text').value = preset.text || '';
    $('#dialog-task-category').value = preset.category || els.quickCategory.value;
    $('#dialog-task-priority').value = preset.priority || 'normal';
    $('#dialog-task-due').value = preset.dueDate || '';
    $('#dialog-task-notes').value = preset.notes || '';
  }
  els.taskDialog.showModal();
  setTimeout(() => $('#dialog-task-text').focus(), 40);
}
function openCategoryDialog(categoryId = null) {
  $('#category-dialog-form').dataset.editId = categoryId || '';
  $('#new-category-name').value = '';
  $('#new-category-color').value = '#2563eb';
  if (categoryId) {
    getCategories().then(categories => {
      const category = categories.find(c => c.id === categoryId);
      if (!category) return;
      $('#category-dialog-form').dataset.editId = category.id;
      $('#new-category-name').value = category.name;
      $('#new-category-color').value = category.color;
    });
  }
  els.categoryDialog.querySelector('h2').textContent = categoryId ? 'Edit category' : 'Add category';
  els.categoryDialog.querySelector('.primary-btn').textContent = categoryId ? 'Save category' : 'Add category';
  els.categoryDialog.showModal();
}

async function createQuickTask(text, options = {}) {
  const existing = await getAllTasks();
  const task = normalizeTask({
    id: uid(), text, category: options.category || els.quickCategory.value || 'work', priority: options.priority || 'normal', dueDate: options.dueDate || '',
    status: 'active', completed: false, order: existing.length, isDeleted: false, createdAt: nowISO(), updatedAt: nowISO()
  });
  await addTask(task);
  return task;
}

function updateQuickParsePreview() {
  const preview = $('#quick-parse-preview');
  if (!preview || !els.quickInput) return;
  const parsed = parseNaturalQuickEntry(els.quickInput.value, categoryCache);
  if (!parsed.recognized) { preview.textContent = ''; preview.classList.add('hidden'); return; }
  const chosenCategory = quickCategoryOverridden ? els.quickCategory.value : (parsed.categoryId || els.quickCategory.value);
  const category = categoryCache.find(item => item.id === chosenCategory);
  const chosenDate = quickDueOverridden ? els.quickDue.value : (parsed.dueDate || els.quickDue.value);
  const due = chosenDate ? dateLabel(chosenDate) : '';
  preview.textContent = `Ready to add: ${parsed.text}${category ? ` · ${category.icon} ${category.name}` : ''}${due ? ` · ${due}` : ''}. Check the fields above before adding.`;
  preview.classList.remove('hidden');
}

function handleQuickTextInput() {
  if (quickAutoCategory && !quickCategoryOverridden && els.quickCategory.value === quickAutoCategory) els.quickCategory.value = categoryCache[0]?.id || '';
  if (quickAutoDue && !quickDueOverridden && els.quickDue.value === quickAutoDue) els.quickDue.value = '';
  quickAutoCategory = '';
  quickAutoDue = '';
  quickCategoryOverridden = false;
  quickDueOverridden = false;
  const parsed = parseNaturalQuickEntry(els.quickInput.value, categoryCache);
  if (parsed.categoryId) { els.quickCategory.value = parsed.categoryId; quickAutoCategory = parsed.categoryId; }
  if (parsed.dueDate) { els.quickDue.value = parsed.dueDate; quickAutoDue = parsed.dueDate; }
  updateQuickParsePreview();
}

function nextOccurrenceDate(task) {
  const recurrence = task.recurrence;
  const source = task.dueDate || task.occurrenceDate || toDateKey(new Date());
  const date = fromDateKey(source);
  if (recurrence.frequency === 'daily') date.setDate(date.getDate() + 1);
  else if (recurrence.frequency === 'weekly') date.setDate(date.getDate() + 7);
  else if (recurrence.frequency === 'custom') date.setDate(date.getDate() + Math.max(1, recurrence.interval));
  else if (recurrence.frequency === 'monthly') {
    const originalDay = recurrence.anchorDay || date.getDate();
    date.setDate(1);
    date.setMonth(date.getMonth() + 1);
    date.setDate(Math.min(originalDay, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()));
  }
  return toDateKey(date);
}

async function createNextOccurrence(completedTask) {
  if (!completedTask.recurrence || !completedTask.seriesId) return;
  const dueDate = nextOccurrenceDate(completedTask);
  const id = `${completedTask.seriesId}::${dueDate}`;
  const now = nowISO();
  const reminder = completedTask.reminder ? { ...completedTask.reminder, sentAt: '' } : null;
  if (reminder?.type === 'at') reminder.at = new Date(`${dueDate}T${reminder.time || '09:00'}:00`).toISOString();
  if (reminder?.type === 'tomorrow') {
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    const [hours, minutes] = reminder.time.split(':').map(Number); tomorrow.setHours(hours, minutes, 0, 0);
    reminder.at = tomorrow.toISOString();
  }
  const next = normalizeTask({ ...completedTask, id, completed: false, status: 'active', dueDate,
    occurrenceDate: dueDate, reminder, reminderAt: reminder?.at || '', isDeleted: false,
    createdAt: now, updatedAt: now, order: (completedTask.order || 0) + 1 });
  // A deterministic occurrence key plus one read-write transaction prevents duplicate
  // future tasks if completion is submitted twice or by two open tabs.
  const tx = db.transaction(TASK_STORE, 'readwrite');
  const store = tx.objectStore(TASK_STORE);
  const complete = transactionComplete(tx);
  const existing = await requestToPromise(store.get(id));
  if (!existing) store.add(next);
  await complete;
}

function reminderTrigger(task) {
  if (!task.reminder) return null;
  if (task.reminder.type === 'tomorrow') return task.reminder.at ? new Date(task.reminder.at) : null;
  if (task.reminder.type === 'at' && task.reminder.at) return new Date(task.reminder.at);
  if (!task.dueDate) return null;
  const dueAt = new Date(`${task.dueDate}T${task.reminder.time || '09:00'}:00`);
  if (task.reminder.type === '1h') dueAt.setHours(dueAt.getHours() - 1);
  return dueAt;
}

async function checkReminders() {
  if (!db) return;
  const tasks = await getAllTasksRaw();
  const now = Date.now();
  for (const task of tasks) {
    if (task.completed || task.isDeleted || task.reminder?.sentAt) continue;
    const trigger = reminderTrigger(task);
    if (!trigger || Number.isNaN(trigger.getTime()) || trigger.getTime() > now) continue;
    const tx = db.transaction(TASK_STORE, 'readwrite');
    const store = tx.objectStore(TASK_STORE);
    const done = transactionComplete(tx);
    const latest = await requestToPromise(store.get(task.id));
    if (latest && !latest.completed && !latest.reminder?.sentAt) {
      latest.reminder = { ...latest.reminder, sentAt: nowISO() };
      latest.reminderAt = latest.reminder.at || '';
      store.put(latest);
      await done;
      if (task.reminder.notifications && 'Notification' in window && Notification.permission === 'granted') {
        new Notification('Focus Checklist reminder', { body: task.text, tag: `task-reminder-${task.id}` });
      } else {
        const notice = $('#reminder-notice');
        notice.textContent = `Reminder: ${task.text}`;
        notice.classList.remove('hidden');
        clearTimeout(checkReminders.noticeTimer);
        checkReminders.noticeTimer = setTimeout(() => notice.classList.add('hidden'), 9000);
      }
    } else {
      await done;
    }
  }
}

async function handleQuickSubmit(event) {
  event.preventDefault();
  const text = els.quickInput.value.trim();
  if (!text) return;
  if (text.includes('\n')) {
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    for (const line of lines) {
      const parsed = parseNaturalQuickEntry(line, categoryCache);
      await createQuickTask(parsed.text, { category: !quickCategoryOverridden && parsed.categoryId ? parsed.categoryId : els.quickCategory.value, dueDate: !quickDueOverridden && parsed.dueDate ? parsed.dueDate : els.quickDue.value, priority: els.quickPriority.value });
    }
  } else {
    const parsed = parseNaturalQuickEntry(text, categoryCache);
    await createQuickTask(parsed.text, { category: !quickCategoryOverridden && parsed.categoryId ? parsed.categoryId : els.quickCategory.value, dueDate: !quickDueOverridden && parsed.dueDate ? parsed.dueDate : els.quickDue.value, priority: els.quickPriority.value });
  }
  els.quickInput.value = '';
  els.quickDue.value = '';
  els.quickCategory.value = categoryCache[0]?.id || '';
  quickCategoryOverridden = false; quickDueOverridden = false; quickAutoCategory = ''; quickAutoDue = '';
  els.quickPriority.value = 'normal';
  updateQuickParsePreview();
  await refreshAll();
  els.quickInput.focus();
}

function tryVoiceInput(targetInput = els.quickInput, triggerButton = null) {
  if (activeRecognition) { activeRecognition.stop(); return; }
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const status = targetInput === els.quickInput ? $('#voice-status') : $('#notes-voice-status');
  if (!SpeechRecognition) {
    status.textContent = 'Voice input is not available here. You can still type or paste text.';
    status.classList.remove('hidden');
    return;
  }
  const recognition = new SpeechRecognition();
  activeRecognition = recognition;
  const button = triggerButton || (targetInput === els.quickInput ? $('#quick-voice-btn') : $('#dialog-note-voice'));
  const original = targetInput.value.trim();
  let finalTranscript = '';
  recognition.lang = voiceLanguage === 'auto' ? (navigator.language || 'en-US') : voiceLanguage;
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.onstart = () => {
    button.classList.add('listening');
    button.textContent = '■';
    button.setAttribute('aria-label', 'Stop voice input');
    button.title = 'Stop listening';
    status.textContent = 'Listening… Tap the microphone again to stop.';
    status.classList.remove('hidden');
    setSaveStatus('Listening…');
  };
  recognition.onresult = event => {
    let interim = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const transcript = event.results[index][0].transcript.trim();
      if (event.results[index].isFinal) finalTranscript += `${finalTranscript ? ' ' : ''}${transcript}`;
      else interim += `${interim ? ' ' : ''}${transcript}`;
    }
    const spoken = `${finalTranscript}${interim ? `${finalTranscript ? ' ' : ''}${interim}` : ''}`.trim();
    targetInput.value = [original, spoken].filter(Boolean).join(original && spoken ? ' ' : '');
    if (targetInput === els.quickInput) handleQuickTextInput();
    status.textContent = interim ? `Hearing: ${interim}` : 'Voice text added. Review it before saving.';
    targetInput.focus();
  };
  recognition.onerror = event => {
    const messages = { 'not-allowed':'Microphone access was blocked. You can type or paste instead.', 'no-speech':'No speech was heard. Try again when ready.', 'audio-capture':'No microphone was available.', network:'Voice recognition is unavailable right now.' };
    status.textContent = messages[event.error] || `Voice input ended (${event.error}). You can retry or type instead.`;
    status.classList.remove('hidden');
  };
  recognition.onend = () => {
    button.classList.remove('listening');
    button.textContent = '🎤';
    button.setAttribute('aria-label', targetInput === els.quickInput ? 'Add task by voice' : 'Dictate note');
    button.title = targetInput === els.quickInput ? 'Voice add' : 'Voice to note';
    activeRecognition = null;
    if (finalTranscript) status.textContent = 'Voice text added. Review it before saving.';
    setSaveStatus();
    setTimeout(() => { if (!activeRecognition && status.textContent.includes('Voice text added')) status.classList.add('hidden'); }, 5000);
  };
  try { recognition.start(); }
  catch (error) { activeRecognition = null; status.textContent = `Voice input could not start: ${error.message}`; status.classList.remove('hidden'); }
}

async function openFocusMode() {
  const tasks = await getAllTasks();
  const candidates = tasks.filter(t => !t.completed && t.status !== 'waiting').sort((a,b) => taskAttentionScore(a) - taskAttentionScore(b));
  const task = candidates[0];
  if (!task) {
    els.focusTask.textContent = 'Nothing needs doing right now.';
    els.focusMeta.textContent = 'Your active list is clear.';
    focusTaskId = null;
    els.focusComplete.disabled = true;
    els.focusSkip.disabled = true;
  } else {
    focusTaskId = task.id;
    els.focusComplete.disabled = false;
    els.focusSkip.disabled = false;
    const categories = await getCategories();
    const c = categories.find(c => c.id === task.category);
    els.focusTask.textContent = task.text;
    els.focusMeta.textContent = `${c?.icon || '📌'} ${c?.name || task.category} · ${priorityLabel(task.priority)}${task.dueDate ? ` · ${dateLabel(task.dueDate)}` : ''}${task.subLabels?.length ? ` · ${task.subLabels.join(', ')}` : ''}${task.waitingFor ? ` · Waiting for ${task.waitingFor}` : ''}`;
  }
  els.focusModal.classList.remove('hidden');
  els.focusComplete.focus();
}
async function focusCompleteTask() {
  if (!focusTaskId) return;
  const tasks = await getAllTasks(); const task = tasks.find(t => t.id === focusTaskId); if (!task) return;
  task.completed = true; task.status = 'completed'; await upsertTask(task); await createNextOccurrence(task); await refreshAll(); await openFocusMode();
}
async function focusSkipTask() {
  if (!focusTaskId) return;
  const tasks = await getAllTasks(); const task = tasks.find(t => t.id === focusTaskId); if (!task) return;
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate()+1);
  setTaskDueDate(task, toDateKey(tomorrow)); await upsertTask(task); await refreshAll(); await openFocusMode();
}

async function updateOnlineStatus() {
  const online = navigator.onLine;
  els.saveStatus.textContent = online ? 'Saved on this device' : 'Offline · changes stay on this device';
}

async function exportBackup() {
  const [tasks, categories, settingsRaw] = await Promise.all([getAllTasksRaw(), getCategories(), getAllSettings()]);
  const payload = { app: 'Focus Checklist', version: 2, exportedAt: nowISO(), tasks, categories, settings: settingsRaw };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `focus-checklist-backup-${toDateKey(new Date())}.json`; anchor.click();
  URL.revokeObjectURL(url);
  els.backupStatus.textContent = `Backup exported ${formatDate(new Date(), {day:'numeric',month:'short',year:'numeric'})}.`;
}
async function getAllSettings() {
  const tx = db.transaction(SETTINGS_STORE, 'readonly');
  return requestToPromise(tx.objectStore(SETTINGS_STORE).getAll());
}
async function importBackup(file) {
  const text = await file.text();
  const parsed = JSON.parse(text);
  const tasks = Array.isArray(parsed) ? parsed : parsed.tasks;
  if (!Array.isArray(tasks)) throw new Error('This backup does not contain a task list.');
  const categories = Array.isArray(parsed.categories) ? parsed.categories : [];
  const settings = Array.isArray(parsed.settings) ? parsed.settings : [];

  const tx = db.transaction([TASK_STORE, CATEGORY_STORE, SETTINGS_STORE], 'readwrite');
  const taskStore = tx.objectStore(TASK_STORE);
  const categoryStore = tx.objectStore(CATEGORY_STORE);
  const settingsStore = tx.objectStore(SETTINGS_STORE);
  tasks.filter(Boolean).forEach(task => taskStore.put(normalizeTask(task, task.id || uid())));
  categories.filter(Boolean).forEach(category => categoryStore.put(category));
  settings.filter(Boolean).forEach(setting => settingsStore.put(setting));
  await transactionComplete(tx);
  setSaveStatus('Backup restored');
}

async function saveDialogTask(event) {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') { els.taskDialog.close(); return; }
  const text = $('#dialog-task-text').value.trim();
  if (!text) return;
  const id = $('#edit-task-id').value || uid();
  const tasks = await getAllTasks();
  const existing = tasks.find(t => t.id === id);
  const repeatFrequency = $('#dialog-task-repeat').value;
  const reminderType = $('#dialog-task-reminder').value;
  const reminderTime = $('#dialog-task-reminder-time').value || '09:00';
  if ((reminderType === 'at' || reminderType === '1h') && !$('#dialog-task-due').value) {
    alert('Add a due date to use a scheduled reminder or “1 hour before”.');
    return;
  }
  if ($('#dialog-task-notification').checked && 'Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
  let reminder = null;
  if (reminderType !== 'none') {
    let at = '';
    if (reminderType === 'at' && $('#dialog-task-due').value) {
      at = new Date(`${$('#dialog-task-due').value}T${reminderTime}:00`).toISOString();
    }
    if (reminderType === 'tomorrow') {
      const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
      const [hours, minutes] = reminderTime.split(':').map(Number); tomorrow.setHours(hours, minutes, 0, 0); at = tomorrow.toISOString();
    }
    reminder = { type: reminderType, time: reminderTime, notifications: $('#dialog-task-notification').checked, at,
      sentAt: existing?.reminder?.type === reminderType && existing?.reminder?.at === at ? (existing.reminder.sentAt || '') : '' };
  }
  const task = normalizeTask({
    ...(existing || {}), id, text, category: $('#dialog-task-category').value, priority: $('#dialog-task-priority').value,
    status: $('#dialog-task-status').value, completed: $('#dialog-task-status').value === 'completed', dueDate: $('#dialog-task-due').value,
    recurrence: repeatFrequency === 'none' ? null : { frequency: repeatFrequency, interval: repeatFrequency === 'custom' ? Math.min(3650, Math.max(1, Number($('#dialog-task-repeat-interval').value) || 1)) : 1, anchorDay: Number(($('#dialog-task-due').value || toDateKey(new Date())).slice(-2)) },
    seriesId: repeatFrequency === 'none' ? '' : (existing?.seriesId || id),
    occurrenceDate: $('#dialog-task-due').value || existing?.occurrenceDate || toDateKey(new Date()),
    reminder, reminderAt: reminder?.at || '',
    subLabels: parseLabels($('#dialog-task-labels').value), waitingFor: $('#dialog-task-waiting').value.trim(), followUpDate: $('#dialog-task-followup').value, notes: $('#dialog-task-notes').value.trim(),
    isDeleted: false, order: existing?.order ?? tasks.length, createdAt: existing?.createdAt || nowISO(), updatedAt: nowISO()
  });
  await upsertTask(task);
  els.taskDialog.close();
  await refreshAll();
  await checkReminders();
}

async function handleDeleteFromDialog() {
  const id = $('#edit-task-id').value; if (!id) return;
  const tasks = await getAllTasks(); const task = tasks.find(t => t.id === id); if (!task) return;
  if (!confirm(`Delete “${task.text}”?`)) return;
  await softDeleteTask(task); els.taskDialog.close(); await refreshAll();
}

async function handleCategorySave(event) {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') { els.categoryDialog.close(); return; }
  const editId = $('#category-dialog-form').dataset.editId;
  const name = $('#new-category-name').value.trim();
  const color = $('#new-category-color').value;
  if (!name) return;
  const categories = await getCategories();
  const duplicate = categories.find(c => c.name.toLowerCase() === name.toLowerCase() && c.id !== editId);
  if (duplicate) { alert('A category with that name already exists.'); return; }
  await saveCategory({ id: editId || slugify(name) || uid(), name, color, icon: editId ? (categories.find(c=>c.id===editId)?.icon || '📌') : '📌', builtIn:false, legacy:false });
  els.categoryDialog.close();
  await refreshAll();
}

async function refreshAll() {
  const tasks = await getAllTasks();
  await ensureLegacyCategories(tasks);
  await populateCategoryControls();
  await renderToday();
  await renderTasks();
  await renderWaiting();
  await renderCalendar();
  await renderSettings();
}

function wireEvents() {
  $$('.nav-btn[data-view]').forEach(btn => btn.addEventListener('click', () => openView(btn.dataset.view)));
  $('#menu-btn')?.addEventListener('click', () => els.sidebar.classList.toggle('menu-open'));
  $('#quick-add-sidebar')?.addEventListener('click', () => openTaskDialog());
  $('#mobile-add-btn')?.addEventListener('click', () => openTaskDialog());
  $('#tasks-add-btn')?.addEventListener('click', () => openTaskDialog());
  $('#quick-category-btn')?.addEventListener('click', () => openCategoryDialog());
  $('#settings-add-category')?.addEventListener('click', () => openCategoryDialog());
  $('#focus-btn')?.addEventListener('click', openFocusMode);
  $('#today-focus-btn')?.addEventListener('click', openFocusMode);
  els.focusClose.addEventListener('click', () => els.focusModal.classList.add('hidden'));
  els.focusComplete.addEventListener('click', focusCompleteTask);
  els.focusSkip.addEventListener('click', focusSkipTask);
  $('#voice-top-btn')?.addEventListener('click', () => tryVoiceInput(els.quickInput, $('#voice-top-btn')));
  $('#quick-voice-btn')?.addEventListener('click', () => tryVoiceInput(els.quickInput, $('#quick-voice-btn')));
  $('#dialog-note-voice')?.addEventListener('click', () => tryVoiceInput($('#dialog-task-notes'), $('#dialog-note-voice')));
  els.quickTaskForm.addEventListener('submit', handleQuickSubmit);
  els.quickInput.addEventListener('input', handleQuickTextInput);
  els.quickCategory.addEventListener('change', () => { quickCategoryOverridden = true; updateQuickParsePreview(); });
  els.quickDue.addEventListener('change', () => { quickDueOverridden = true; updateQuickParsePreview(); });
  $('#template-form').addEventListener('submit', saveTemplate);
  $('#dialog-task-repeat').addEventListener('change', e => $('#repeat-interval-field').classList.toggle('hidden', e.target.value !== 'custom'));
  $('#dialog-task-reminder').addEventListener('change', e => $('#reminder-time-field').classList.toggle('hidden', e.target.value === 'none' || e.target.value === '1h'));
  $('#task-dialog-form').addEventListener('submit', saveDialogTask);
  $('#delete-task-dialog').addEventListener('click', handleDeleteFromDialog);
  $('#category-dialog-form').addEventListener('submit', handleCategorySave);
  $('#move-date-form').addEventListener('submit', saveMovedTaskDate);

  $$('.segment-btn').forEach(btn => btn.addEventListener('click', async () => {
    $$('.segment-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active'); currentTodayFilter = btn.dataset.todayFilter; await renderToday();
  }));
  $('#today-search-toggle').addEventListener('click', () => { els.todaySearchWrap.classList.toggle('hidden'); if (!els.todaySearchWrap.classList.contains('hidden')) els.todaySearch.focus(); });
  els.todaySearch.addEventListener('input', renderToday);
  els.globalSearch.addEventListener('input', renderTasks);
  els.statusFilter.addEventListener('change', renderTasks);
  els.priorityFilter.addEventListener('change', renderTasks);
  els.dateFilter.addEventListener('change', renderTasks);
  $('#selection-mode-btn').addEventListener('click', () => { selectionMode = !selectionMode; if (!selectionMode) selectedTaskIds.clear(); renderTasks(); });
  $('#bulk-complete').addEventListener('click', event => { const button = event.currentTarget; button.dataset.active = button.dataset.active === 'true' ? 'false' : 'true'; button.classList.toggle('selected', button.dataset.active === 'true'); button.textContent = button.dataset.active === 'true' ? '✓ Complete selected' : 'Complete'; });
  $('#bulk-apply').addEventListener('click', applyBulkChanges);
  $('#prev-month').addEventListener('click', () => { calendarCursor.setMonth(calendarCursor.getMonth()-1); renderCalendar(); });
  $('#next-month').addEventListener('click', () => { calendarCursor.setMonth(calendarCursor.getMonth()+1); renderCalendar(); });
  els.labelCategory.addEventListener('change', renderLabels);
  $('#add-label-btn').addEventListener('click', async () => {
    const label = els.newLabelInput.value.trim(); const categoryId = els.labelCategory.value; if (!label || !categoryId) return;
    const labels = await getSetting(`labels:${categoryId}`, []); if (!labels.includes(label)) labels.push(label); await saveSetting(`labels:${categoryId}`, labels.sort((a,b)=>a.localeCompare(b))); els.newLabelInput.value=''; renderLabels();
  });
  els.newLabelInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#add-label-btn').click(); } });
  $('#reduce-motion').addEventListener('change', async e => { document.body.classList.toggle('reduce-motion', e.target.checked); await saveSetting('reduceMotion', e.target.checked); });
  $('#large-text').addEventListener('change', async e => { document.body.classList.toggle('large-text', e.target.checked); await saveSetting('largeText', e.target.checked); });
  $('#voice-language').addEventListener('change', async e => { voiceLanguage = e.target.value; await saveSetting('voiceLanguage', voiceLanguage); });
  $('#export-btn').addEventListener('click', exportBackup);
  $('#import-btn').addEventListener('click', () => els.importFile.click());
  els.importFile.addEventListener('change', async e => { const file=e.target.files[0]; if(!file) return; try { await importBackup(file); alert('Backup restored successfully.'); await refreshAll(); } catch(err) { console.error(err); alert(`Could not restore that backup: ${err.message}`); } finally { e.target.value=''; } });
  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);
  window.addEventListener('focus', checkReminders);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkReminders(); });
  setInterval(checkReminders, 30000);
}

async function loadSettings() {
  const [reduceMotion, largeText, savedVoiceLanguage] = await Promise.all([getSetting('reduceMotion', false), getSetting('largeText', false), getSetting('voiceLanguage', 'auto')]);
  voiceLanguage = ['auto','en-GB','en-US','es-ES','fr-FR'].includes(savedVoiceLanguage) ? savedVoiceLanguage : 'auto';
  $('#voice-language').value = voiceLanguage;
  $('#reduce-motion').checked = Boolean(reduceMotion);
  $('#large-text').checked = Boolean(largeText);
  document.body.classList.toggle('reduce-motion', Boolean(reduceMotion));
  document.body.classList.toggle('large-text', Boolean(largeText));
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      newWorker = reg.installing;
      newWorker?.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) els.updateToast.classList.remove('hidden');
      });
    });
  }).catch(err => console.error('Service Worker Error:', err));
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!refreshing) { refreshing = true; window.location.reload(); } });
  els.reloadBtn.addEventListener('click', () => newWorker?.postMessage({ action: 'skipWaiting' }));
}

(async function init() {
  try {
    wireEvents();
    await initDB();
    const tasks = await getAllTasks();
    await ensureLegacyCategories(tasks);
    await loadSettings();
    await refreshAll();
    updateOnlineStatus();
    registerServiceWorker();
  } catch (error) {
    console.error(error);
    document.body.innerHTML = `<main style="padding:24px;font-family:system-ui"><h1>Could not open your checklist</h1><p>Please close and reopen the app. Your existing local data has not been intentionally deleted.</p><pre style="white-space:pre-wrap">${escapeHTML(error.stack || error.message || String(error))}</pre></main>`;
  }
})();
