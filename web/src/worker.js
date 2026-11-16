// Runs the in-page planner off the main thread, so the page keeps animating while it re-plans.
import { solve } from './engine.js';

self.onmessage = (e) => {
  const r = solve(e.data.data, e.data.opt, (l) => self.postMessage({ log: l }));
  self.postMessage({ done: r });
};
