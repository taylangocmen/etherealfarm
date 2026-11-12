/* Read-only public game information. No changes to dynamics, rewards or actions. */
(function() {
  var original = headlessBridge.observe;
  function number(n) { return {b: n.b, e: n.e}; }
  function rates(r) { return {seeds: number(r.seeds), spores: number(r.spores)}; }
  headlessBridge.observe = function() {
    var o = original();
    o.production = rates(prefield.reduce(function(total, row) {
      row.forEach(function(p) { total.addInPlace(p.prod2); });
      return total;
    }, new Res()));
    o.field.forEach(function(row) { row.forEach(function(cell) {
      var f = state.field[cell.y][cell.x], c = f.getCrop();
      cell.production = rates(prefield[cell.y][cell.x].prod2);
      cell.recoup = rates(c ? c.getRecoup(f) : new Res());
    }); });
    o.crops.forEach(function(c) {
      c.baseProduction = rates(crops[c.id].prod);
      c.everMature = !!state.crops[c.id].had;
    });
    return o;
  };
})();
