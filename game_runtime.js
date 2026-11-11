/* Ethereal Farm — GPL-3.0-or-later; see LICENSE. */

// Host services. The browser uses these defaults; the local headless runner
// supplies its own implementation before loading this file. No DOM is needed
// merely to load the simulation scripts.
var gameRuntime = typeof gameRuntime === 'undefined' ? {
  headless: false,
  now: function() { return Date.now() / 1000; },
  random: function() { return Math.random(); },
  schedule: function(callback, milliseconds) {
    return window.setTimeout(callback, milliseconds);
  },
  // null: use the real calendar. 0: the non-holiday benchmark.
  holiday: null
} : gameRuntime;
