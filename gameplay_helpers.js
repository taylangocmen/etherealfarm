/*
Ethereal Farm
Copyright (C) 2020-2026  Lode Vandevenne

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

// Shared gameplay helpers formerly declared in UI files.

// color types for log message
var C_DEFAULT = 0; // anything that doesn't need to stand out, includes almost any immediate response to user action such as performing an upgrade (as opposed to having an upgrade unlocked due to other events)
var C_ERROR = 1; // program error
var C_INVALID = 2; // usage errors such as not enough resources
var C_UNIMPORTANT = 3;
var C_RANDOM = 4;
var C_META = 5;
var C_HELP = 6;
var C_NATURE = 7; // basic field, ferns, fruits, ...
var C_ETHEREAL = 8;
var C_UNLOCK = 9; // achievements, unlocked upgrades, ...
var C_UNDO = 10;
var C_AUTOMATON = 11;
var C_AMBER = 12;
var C_PRESENT = 13;
var C_EGG = 14;
var C_GOAL = 15;
var C_IMPORTANT = 16;
var C_TD = 17; // tower defense related
var C_INFINITY = 18; // infinity field related



var MAXFRUITARROWS = 10;

// Production is simulation state, also consumed by the browser resource display.
var gain = Res();

function getFruitAbilityName(ability, opt_abbreviation) {
  if(opt_abbreviation) {
    switch(ability) {
      case FRUIT_NONE: return '/';
      case FRUIT_BERRYBOOST: return 'BB';
      case FRUIT_MUSHBOOST: return 'MB';
      case FRUIT_MUSHEFF: return 'ME';
      case FRUIT_FLOWERBOOST: return 'FB';
      case FRUIT_GROWSPEED: return 'G';
      case FRUIT_WEATHER: return 'WB';
      case FRUIT_BRASSICA: return 'BC';
      case FRUIT_NETTLEBOOST: return 'NB';
      // S from "season", the actual season is known due to the fruit's name which includes the season in it
      case FRUIT_SPRING: return getSeason() == 0 ? 'S' : 's';
      case FRUIT_SUMMER: return getSeason() == 1 ? 'S' : 's';
      case FRUIT_AUTUMN: return getSeason() == 2 ? 'S' : 's';
      case FRUIT_WINTER: return getSeason() == 3 ? 'S' : 's';
      case FRUIT_SPRING_SUMMER: return ((getSeason() == 0 || getSeason() == 1) && haveFruitMix(1)) ? 'S' : 's';
      case FRUIT_SUMMER_AUTUMN: return ((getSeason() == 1 || getSeason() == 2) && haveFruitMix(1)) ? 'S' : 's';
      case FRUIT_AUTUMN_WINTER: return ((getSeason() == 2 || getSeason() == 3) && haveFruitMix(1)) ? 'S' : 's';
      case FRUIT_WINTER_SPRING: return ((getSeason() == 3 || getSeason() == 0) && haveFruitMix(1)) ? 'S' : 's';
      case FRUIT_ALL_SEASON: return haveFruitMix(2) ? 'S' : 's';
      case FRUIT_ALL_SEASON2: return haveFruitMix(3) ? 'S' : 's';
      case FRUIT_INFERNAL: return 'I';
      case FRUIT_RESINBOOST: return 'RS';
      case FRUIT_TWIGSBOOST: return 'TW';
      case FRUIT_RESIN_TWIGS: return 'RT';
      case FRUIT_NUTBOOST: return 'NU';
      case FRUIT_BEEBOOST: return 'BE';
      case FRUIT_MIX: return 'X';
      case FRUIT_TREELEVEL: return 'T';
      case FRUIT_SEED_OVERLOAD: return 'O';
      case FRUIT_SPORES_OVERLOAD: return 'MO'; // mo = mushroom overload
      case FRUIT_GROW_ENHANCE: return 'E';
    }
    return '?';
  }
  switch(ability) {
    case FRUIT_NONE: return 'none';
    case FRUIT_BERRYBOOST: return 'berry boost';
    case FRUIT_MUSHBOOST: return 'mushroom boost';
    case FRUIT_MUSHEFF: return 'mushroom economy';
    case FRUIT_FLOWERBOOST: return 'flower boost';
    case FRUIT_GROWSPEED: return 'growing speed';
    case FRUIT_WEATHER: return 'weather boost';
    case FRUIT_BRASSICA: return 'brassica copying';
    case FRUIT_NETTLEBOOST: return 'nettle boost';
    case FRUIT_SPRING: return 'spring boost';
    case FRUIT_SUMMER: return 'summer boost';
    case FRUIT_AUTUMN: return 'autumn boost';
    case FRUIT_WINTER: return 'winter boost';
    case FRUIT_SPRING_SUMMER: return 'spring and summer boost';
    case FRUIT_SUMMER_AUTUMN: return 'summer and autumn boost';
    case FRUIT_AUTUMN_WINTER: return 'autumn and winter boost';
    case FRUIT_WINTER_SPRING: return 'winter and spring boost';
    case FRUIT_ALL_SEASON: return '4-seasons boost';
    case FRUIT_ALL_SEASON2: return 'ultra seasons boost';
    case FRUIT_INFERNAL: return 'infernal boost (challenge only)';
    case FRUIT_RESINBOOST: return 'resin boost';
    case FRUIT_TWIGSBOOST: return 'twigs boost';
    case FRUIT_RESIN_TWIGS: return 'resin and twigs boost';
    case FRUIT_NUTBOOST: return 'nuts boost';
    case FRUIT_BEEBOOST: return 'bee boost';
    case FRUIT_MIX: return 'mix nettle/brass/bee';
    case FRUIT_TREELEVEL: return 'treelevel prod boost';
    case FRUIT_SEED_OVERLOAD: return 'seeds overload';
    case FRUIT_SPORES_OVERLOAD: return 'spores overload';
    case FRUIT_GROW_ENHANCE: return 'grow and enhance';
  }
  return 'unknown';
}

function getNumFruitArrows() {
  return Math.min(MAXFRUITARROWS, state.fruit_slots);
}

// returns whether the fruit is probably interesting enough for the player to be dropped into the stored fruits rather than the cacrificial pool
// return value meanings:
// 0: not interesting
// 1: somewhat interesting
// 2: very interesting
// these heuristics are not flawless and a player should take a look at the fruit tab before transcending anyway, when looking for a particular fruit to fuse, ...
// NOTE: this function comes with some risk of player expecting high tier fruits to always be dropped in main stored slot or always highlight tab for new high tier fruits, so should not overdo it, only make tab red if the high tier fruits clearly are novel
function isFruitInteresting(fruit) {
  var best = -1;
  for(var i = 0; i < state.fruit_stored.length; i++) {
    var f = state.fruit_stored[i];
    if(!f) continue;
    best = Math.max(best, f.tier);
  }

  if(fruit.tier > best) return 2; // if the new fruit has a higher tier than any fruit you have, it's definitely interesting
  if(fruit.tier < best) return 0; // if lower than best tier you have, it's definitely not interesting


  var numbest = 0;
  var numbest2 = 0;
  var newseason = (fruit.type > 0);
  for(var i = 0; i < state.fruit_stored.length; i++) {
    var f = state.fruit_stored[i];
    if(fruit.type != 11 && f.type == 11) continue; // skip mandrakes for this count, if you have e.g. 5 ruby fruits and 12 emerald mandrakes, the emerald mandrakes should _not_ make it consider the ruby fruits to be interesting because mandrakes are a separately collected type of fruit
    if(!f) continue;
    if(f.tier == best) numbest++;
    else if(f.tier + 1 == best) numbest2++;
    if(newseason && f.tier == best && fruitContainsSeasonalType(f, fruit.type)) newseason = false;
  }
  if(newseason) return 2; // a new season is very interesting

  if(numbest < numbest2) return 1;
  //if(getActiveFruit() && getActiveFruit().tier + 1 == fruit.tier) return 1; // if the player is using a fruit with tier - 1, then likely that one still has better abilities and the player is trying to collect next tier fruits, so consider it interesting. This is interesting, but not interesting enough to warrant returning 2, because this heuristic depends on carried fruit

  return 0;
}

// Keep this list aligned with getChoiceUpgradeLevels in ui_automaton.js.
function getChoiceUpgrades() {
  return [fern_choice0, active_choice0, watercress_choice0, resin_choice0];
}
