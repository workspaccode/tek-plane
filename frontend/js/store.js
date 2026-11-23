// Global app state + a tiny event bus.
import { api } from './api.js';

const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}

export function emit(event, data) {
  listeners.get(event)?.forEach((fn) => {
    try { fn(data); } catch (err) { console.error(err); }
  });
}

export const state = {
  user: null,
  projects: [],
  board: null, // { project, members, sections, tags, tasks, online_user_ids }
  timer: null,
  unread: 0,
  pinnedTaskIds: new Set(),
};

export async function loadProjects() {
  state.projects = await api.get('/projects');
  emit('projects', state.projects);
  return state.projects;
}

export async function loadBoard(projectId, { includeClosed = true } = {}) {
  const board = await api.get(`/projects/${projectId}?include_closed=${includeClosed}`);
  state.board = board;
  emit('board', board);
  return board;
}

export async function loadTimer() {
  state.timer = await api.get('/me/timer');
  emit('timer', state.timer);
  return state.timer;
}

export async function loadPinned() {
  state.pinnedTaskIds = new Set(await api.get('/agenda/pinned-task-ids'));
  emit('pinned', state.pinnedTaskIds);
}

/** Merge a task summary into the open board (if it belongs to it). */
export function upsertBoardTask(task) {
  const b = state.board;
  if (!b || b.project.id !== task.project_id) return;
  const i = b.tasks.findIndex((t) => t.id === task.id);
  if (i >= 0) b.tasks[i] = { ...b.tasks[i], ...task };
  else b.tasks.push(task);
  emit('board', b);
}

export function removeBoardTask(taskId) {
  const b = state.board;
  if (!b) return;
  b.tasks = b.tasks.filter((t) => t.id !== taskId);
  emit('board', b);
}

// ------------------------------------------------------------------ board lookups

export function member(id) {
  return state.board?.members.find((m) => m.id === id) || (state.user?.id === id ? state.user : null);
}

export function tag(id) {
  return state.board?.tags.find((t) => t.id === id) || null;
}

export function section(id) {
  return state.board?.sections.find((s) => s.id === id) || null;
}

export function myRole() {
  return state.board?.project.role || 'viewer';
}

const RANK = { viewer: 0, member: 1, admin: 2, owner: 3 };

export function can(minimum, role = myRole()) {
  return RANK[role] >= RANK[minimum];
}
