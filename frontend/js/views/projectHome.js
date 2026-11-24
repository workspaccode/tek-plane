// /projects/:id → the project's home view: the board, or the map for mind map projects.
import { api } from '../api.js';
import { state } from '../store.js';

export default async function render(root, ctx) {
  const id = Number(ctx.params.id);
  let p = state.projects.find((x) => x.id === id);
  if (!p) p = (await api.get(`/projects/${id}?include_closed=false`)).project;
  const mod = p.kind === 'mindmap' ? await import('./mindmap.js') : await import('./board.js');
  return mod.default(root, ctx);
}
