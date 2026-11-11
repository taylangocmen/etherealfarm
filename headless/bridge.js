/* Ethereal Farm — GPL-3.0-or-later; see LICENSE. */

// Runs inside a private VM context. Only JSON observations and action objects
// cross the boundary; callers do not receive state, crop objects, or RNG state.
var headlessBridge = (function() {
  // Private boundary cache. The host only receives detached JSON copies.
  // Every engine tick invalidates it, including each tick of a batched wait.
  var cachedLegalActions;
  var inspectFlags = {
    help: 'showing_help', changelog: 'showing_changelog', stats: 'showing_stats',
    fruit: 'showing_fruit_dialog'
  };
  var inspectMedals = {help: 2000, changelog: 2001, stats: 2002, fruit: 2006};

  function initialize() {
    cachedLegalActions = undefined;
    state = createInitialState();
    state.time = state.prevtime = gameRuntime.now();
    state.saveonaction = false;
    resetGlobalStateVars(state);
    computeDerived(state);
    precomputeField();
    // Same zero-duration initialization update used by the browser. Unlocks and
    // achievements still come from update(), never from hand-edited progression.
    update();
  }

  // Decisions occur at the beginning of the NEXT tick. update() leaves time at
  // the start of its previous interval; use prevtime for boundary-time queries.
  function atBoundary(fn) {
    var previous = state.time;
    state.time = state.prevtime;
    try { return fn(); } finally { state.time = previous; }
  }

  function weather() {
    var unlocks = [upgrade_sununlock, upgrade_mistunlock, upgrade_rainbowunlock];
    var starts = [state.suntime, state.misttime, state.rainbowtime];
    var durations = [getSunDuration(), getMistDuration(), getRainbowDuration()];
    var waits = [getSunWait(), getMistWait(), getRainbowWait()];
    return ['sun', 'mist', 'rainbow'].map(function(name, i) {
      var unlocked = !!state.upgrades[unlocks[i]].count;
      var age = state.time - starts[i];
      return {
        name: name, ability: i, unlocked: unlocked,
        active: unlocked && state.lastWeather == i && age < durations[i],
        remainingSeconds: unlocked ? Math.max(0, durations[i] - age) : 0,
        cooldownSeconds: unlocked ? Math.max(0, waits[i] - age) : 0,
        selectable: unlocked && (age >= waits[i] ||
          (state.lastWeather != i && age < durations[i]))
      };
    });
  }

  function legalActions() {
    if(state.g_numresets > 0) return [];
    if(cachedLegalActions) return cachedLegalActions;
    cachedLegalActions = atBoundary(function() {
      var result = [{type: 'wait'}];
      var availableCrops = registered_crops.filter(function(id) {
        var c = crops[id];
        return state.crops[id].unlocked && c.isReal() && !c.quad;
      });
      // getCost depends on crop counts, not the destination cell. Recoup does
      // depend on the old crop's growth, so calculate it once per cell.
      var costs = {};
      availableCrops.forEach(function(id) { costs[id] = crops[id].getCost(); });
      for(var y = 0; y < state.numh; y++) {
        for(var x = 0; x < state.numw; x++) {
          var cell = state.field[y][x];
          var old = cell.getCrop();
          if(!cell.isEmpty() && !old) continue; // tree or obstacle
          if(old) result.push({type: 'delete', x: x, y: y});
          var recoup = old ? old.getRecoup(cell) : null;
          availableCrops.forEach(function(id) {
            var c = crops[id];
            if(old && old.index == id && c.type != CROPTYPE_BRASSICA) return;
            var cost = costs[id];
            if(old) cost = cost.sub(recoup);
            if(state.res.can_afford(cost)) {
              result.push({type: old ? 'replace' : 'plant', x: x, y: y, crop: id});
            }
          });
        }
      }
      registered_upgrades.forEach(function(id) {
        var u = upgrades[id];
        if(!u.canUpgrade() || !state.res.can_afford(u.getCost())) return;
        if(u.is_choice) {
          result.push({type: 'upgrade', upgrade: id, choice: 1});
          result.push({type: 'upgrade', upgrade: id, choice: 2});
        } else {
          result.push({type: 'upgrade', upgrade: id});
        }
      });
      if(state.fern) result.push({type: 'fern', x: state.fernx, y: state.ferny});
      weather().forEach(function(w) {
        if(w.selectable) result.push({type: 'weather', ability: w.ability});
      });
      for(var i = -1; state.g_numfruits && i < state.fruit_stored.length; i++) {
        if(i != state.fruit_active) result.push({type: 'fruit-select', slot: i});
      }
      state.fruit_stored.forEach(function(f) {
        result.push({type: 'fruit-move', slot: f.slot, destination: 'sacrifice'});
      });
      if(state.fruit_stored.length < state.fruit_slots) {
        state.fruit_sacr.forEach(function(f) {
          result.push({type: 'fruit-move', slot: f.slot, destination: 'storage'});
        });
      }
      Object.keys(inspectFlags).forEach(function(page) {
        if(page == 'fruit' && !state.g_numfruits) return;
        if(!state.medals[inspectMedals[page]].earned) result.push({type: 'inspect', page: page});
      });
      if(state.treelevel >= 10) result.push({type: 'transcend'});
      return result;
    });
    return cachedLegalActions;
  }

  function submit(action) {
    // Match exact schema and current legality. Never accept arbitrary engine
    // actions, by_automaton flags, callbacks, or host-supplied crop objects.
    var match = legalActions().find(function(candidate) {
      var keys = Object.keys(candidate);
      return keys.length == Object.keys(action).length && keys.every(function(k) {
        return candidate[k] === action[k];
      });
    });
    if(!match) throw new Error('Action is not currently legal: ' + JSON.stringify(action));
    switch(action.type) {
      case 'wait': return;
      case 'inspect': globalThis[inspectFlags[action.page]] = true; return;
      case 'plant': case 'replace':
        addAction({type: action.type == 'plant' ? ACTION_PLANT : ACTION_REPLACE,
          x: action.x, y: action.y, crop: crops[action.crop]}); return;
      case 'delete': addAction({type: ACTION_DELETE, x: action.x, y: action.y}); return;
      case 'upgrade': addAction({type: ACTION_UPGRADE, u: action.upgrade, choice: action.choice}); return;
      case 'fern': addAction({type: ACTION_FERN, x: action.x, y: action.y}); return;
      case 'weather': addAction({type: ACTION_ABILITY, ability: action.ability}); return;
      case 'fruit-select': addAction({type: ACTION_FRUIT_ACTIVE, slot: action.slot}); return;
      case 'fruit-move':
        addAction({type: ACTION_FRUIT_SLOT, f: getFruit(action.slot),
          slottype: action.destination == 'storage' ? 0 : 1}); return;
      case 'transcend': addAction({type: ACTION_TRANSCEND, challenge: 0}); return;
    }
    throw new Error('Unsupported action');
  }

  function tick() {
    if(state.g_numresets > 0) throw new Error('Episode has already finished');
    cachedLegalActions = undefined;
    update();
    Object.keys(inspectFlags).forEach(function(page) {
      globalThis[inspectFlags[page]] = false;
    });
    if(actions.length || heavy_computing) throw new Error('Unexpected deferred simulation work');
    return state.g_numresets > 0;
  }

  // Preserve the game's b * 2^e representation; never silently overflow to an
  // ordinary JS Number. Consumers can derive logarithmic features from this.
  function number(n) { return {b: n.b, e: n.e}; }
  function resources(r) {
    var result = {};
    ['seeds', 'spores', 'resin', 'twigs', 'nuts', 'infseeds', 'amber', 'essence', 'infspores'].forEach(function(k) {
      result[k] = number(r[k]);
    });
    return result;
  }
  function fruit(f) {
    return {slot: f.slot, tier: f.tier, type: f.type, abilities: f.abilities.slice(),
      levels: f.levels.slice(), essence: number(f.essence)};
  }
  function observe() {
    return atBoundary(function() {
      return {
        treeLevel: state.treelevel, highestTreeLevel: state.g_treelevel,
        completed: state.g_numresets > 0,
        completionLevel: state.g_numresets ? state.challenges[0].last_completion_level : null,
        resources: resources(state.res), pendingResin: number(getUpcomingResinIncludingFerns()),
        awardedResin: number(state.g_resin_from_transcends),
        treeRequirement: resources(treeLevelReq(state.treelevel + 1)),
        timeAtTreeLevelSeconds: timeAtTreeLevel(state),
        earnedResources: resources(state.c_res),
        collectedFerns: state.c_numferns,
        season: getSeason(), seasonRemainingSeconds: timeTilNextSeason(),
        field: state.field.map(function(row) {
          return row.map(function(cell) {
            var c = cell.getCrop();
            return {x: cell.x, y: cell.y, tile: cell.index,
              crop: c ? c.index : null, growth: cell.growth};
          });
        }),
        crops: registered_crops.filter(function(id) { return state.crops[id].unlocked; }).map(function(id) {
          var c = crops[id];
          return {id: id, name: c.name, type: getCropTypeName(c.type), tier: c.tier,
            cost: resources(c.getCost()), growthSeconds: c.getPlantTime()};
        }),
        upgrades: registered_upgrades.filter(function(id) { return state.upgrades[id].unlocked; }).map(function(id) {
          var u = upgrades[id];
          return {id: id, name: u.name, count: state.upgrades[id].count,
            cropUnlock: !!u.iscropunlock, cropUpgrade: !!u.iscropupgrade,
            crop: u.cropid === undefined ? null : u.cropid,
            exhausted: u.isExhausted(), choice: u.is_choice, cost: resources(u.getCost())};
        }),
        fern: state.fern ? {x: state.fernx, y: state.ferny, kind: state.fern} : null,
        weather: weather(),
        fruits: {active: state.fruit_active, capacity: state.fruit_slots,
          stored: state.fruit_stored.map(fruit), sacrifice: state.fruit_sacr.map(fruit)},
        achievements: registered_medals.filter(function(id) { return state.medals[id].earned; }),
        legalActions: legalActions()
      };
    });
  }

  return {initialize: initialize, submit: submit, tick: tick, observe: observe,
    legalActions: legalActions};
}());
