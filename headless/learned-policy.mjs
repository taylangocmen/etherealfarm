/* Ethereal Farm — GPL-3.0-or-later; see LICENSE. */
// Parameterized policy for evolutionary search. Initial parameters reproduce
// the scripted policy; mutations change priorities, budgets, and cell assignments.
// Pure policy: receives public observations and returns an existing legal action.
// No engine internals, RNG access, UI, timers, or resource grants.
const defaultLayout = [
  ['berry', 'flower', 'berry', 'flower', 'berry'],
  ['berry', 'mushroom', null, 'mushroom', 'berry'],
  ['flower', 'berry', null, 'berry', 'flower'],
  ['berry', 'mushroom', 'flower', 'mushroom', 'berry'],
  ['berry', 'brassica', 'berry', 'brassica', 'berry'],
];
const amount = n => n.b * 2 ** n.e;
export const initialParameters = {
  priorities: [4, 3, 2, 1], unlockFraction: 1, upgradeFraction: 0.1,
  layout: defaultLayout,
};
export function chooseAction(o, parameters = initialParameters) {
  const layout = parameters.layout;
  const actions = o.legalActions;
  const pick = type => actions.find(a => a.type === type);
  let action = pick('transcend') || pick('fern') || pick('inspect');
  if (action) return action;
  const crops = new Map(o.crops.map(c => [c.id, c]));
  const upgrades = new Map(o.upgrades.map(u => [u.id, u]));
  action = actions.find(a => a.type === 'fruit-select' && a.slot >= 0 && o.fruits.active < 0);
  if (action) return action;
  action = actions.find(a => a.type === 'upgrade' && upgrades.get(a.upgrade).choice &&
    a.choice === (['weather choice', 'fern choice'].includes(upgrades.get(a.upgrade).name) ? 2 : 1));
  if (action) return action;
  // Activate one weather effect at a time; prefer mist once mushrooms exist.
  if (!o.weather.some(w => w.active)) {
    const hasMushroom = o.field.flat().some(c => crops.get(c.crop)?.type === 'mushroom');
    action = actions.find(a => a.type === 'weather' && a.ability === (hasMushroom ? 1 : 0));
    if (action) return action;
  }
  // Non-crop unlocks include the free weather abilities.
  action = actions.find(a => a.type === 'upgrade' && !upgrades.get(a.upgrade).cropUpgrade &&
    !upgrades.get(a.upgrade).choice &&
    amount(upgrades.get(a.upgrade).cost.seeds) <= amount(o.resources.seeds) * parameters.unlockFraction);
  if (action) return action;
  // Maintain two cress cells; never replace a live cress with itself.
  // Build seed producers before mushrooms and flowers, then promote tiers.
  const types = ['brassica', 'berry', 'mushroom', 'flower'];
  const order = types.map((type, i) => ({type, priority:parameters.priorities[i]}))
    .sort((a,b) => b.priority-a.priority);
  for (const {type} of order) {
    const candidates = actions.filter(a => {
      if (a.type !== 'plant' && a.type !== 'replace') return false;
      const crop = crops.get(a.crop);
      if (layout[a.y]?.[a.x] !== type || crop?.type !== type) return false;
      const cell = o.field[a.y][a.x];
      const old = crops.get(cell.crop);
      if (old && (old.tier >= crop.tier || cell.growth < 1)) return false;
      if (type === 'mushroom' && ![[a.x-1,a.y],[a.x+1,a.y],[a.x,a.y-1],[a.x,a.y+1]]
        .some(([x,y]) => crops.get(o.field[y]?.[x]?.crop)?.type === 'berry')) return false;
      return true;
    });
    // Favor an affordable higher tier and then empty cells, deterministically.
    candidates.sort((a,b) => crops.get(b.crop).tier - crops.get(a.crop).tier ||
      Number(a.type === 'replace') - Number(b.type === 'replace') || a.y-b.y || a.x-b.x);
    if (candidates.length) return candidates[0];
  }
  // Leave savings for new crops. Only improve crop types currently on the field.
  action = actions.find(a => {
    if (a.type !== 'upgrade') return false;
    const u = upgrades.get(a.upgrade);
    return u.cropUpgrade && o.field.flat().some(c => c.crop === u.crop) &&
      amount(u.cost.seeds) <= amount(o.resources.seeds) * parameters.upgradeFraction;
  });
  return action || pick('wait') || null;
}

