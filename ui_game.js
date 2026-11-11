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

// the "shift+plant" chip at the bottom
var shiftCropFlex = undefined;
var shiftCropFlexId;
var shiftCropFlexX = -1;
var shiftCropFlexY = -1;
var shiftCropFlexShowing;

function removeShiftCropChip() {
  shiftCropFlexShowing = false;

  if(!shiftCropFlex) return;

  shiftCropFlex.removeSelf(gameFlex);
  shiftCropFlex = undefined;
}

function showShiftCropChip(crop_id) {
  removeShiftCropChip();
  var shift = cropChipShiftDown;
  var ctrl = cropChipCtrlDown;
  if(!shift && !ctrl) return;

  var c = crop_id >= 0 ? crops[crop_id] : undefined;

  shiftCropFlexShowing = true; // even when invisible due to not mouse over relevant field tile

  shiftCropFlexId = crop_id;

  var x = shiftCropFlexX;
  var y = shiftCropFlexY;

  var f;
  if(x < 0 || y < 0 || x == undefined || y == undefined) f = new Cell(undefined, undefined, 1); // fake empty field cell to make it indicate "planting"
  else f = state.field[y][x];

  var planting = !f.hasCrop(); // using !f.hasCrop(), rather than f.isEmpty(), to also show the planting chip when mouse is over the tree, rather than showing nothing then, to give the information in more places no matter where the mouse is
  var deleting = f.hasCrop() && ctrl && !shift;
  var replacing = f.hasCrop() && shift && !ctrl;
  //if(replacing && f.getCrop().index == state.lastPlanted) replacing = false; // replacing does not work if same crop. It could be deleting, or nothing, depending on plant growth, but display as nothing
  var upgrading = f.hasCrop() && shift && ctrl && f.getCrop().tier < state.highestoftypeunlocked[f.getCrop().type];
  if(upgrading) c = croptype_tiers[f.getCrop().type][state.highestoftypeunlocked[f.getCrop().type]];
  var selecting = f.hasCrop() && shift && ctrl && f.getCrop().tier >= state.highestoftypeunlocked[f.getCrop().type];
  if(selecting) c = f.getCrop();

  if(!planting && !deleting && !replacing && !upgrading && !selecting) return;

  var keyname = (shift ? (ctrl ? 'Shift+ctrl' : 'Shift') : 'Ctrl');
  var verb = planting ? 'planting' : (deleting ? 'deleting' : (replacing ? 'replacing' : (selecting ? 'selecting' : 'upgrading')));


  shiftCropFlex = new Flex(gameFlex, 0.2, 0.85, 0.8, 0.95);
  shiftCropFlex.div.style.backgroundColor = planting ? '#dfd' : (deleting ? '#fdd' : '#ffd');
  shiftCropFlex.div.style.zIndex = 100; // above medal chip

  var textFlex = new Flex(shiftCropFlex, [0, 0, 0.0], [0.5, 0, -0.35], 0.99, [0.5, 0, 0.35]);
  //textFlex.div.style.color = '#fff';
  textFlex.div.style.color = '#000';
  centerText2(textFlex.div);

  if(deleting) {
    var recoup = f.getCrop().getRecoup(f);
    textFlex.div.textEl.innerHTML = keyname + '+' + verb + '<br><br>recoup: ' + recoup.toString();
  } else {
    if(c) {
      var canvasFlex = new Flex(shiftCropFlex, 0.01, [0.5, 0, -0.35], [0, 0, 0.7], [0.5, 0, 0.35]);
      var canvas = createCanvas('0%', '0%', '100%', '100%', canvasFlex.div);
      renderImage(c.image[4], canvas);
      var updatefun = function() {
        var recoup = Res(0);
        if(f.hasCrop()) recoup = f.getCrop().getRecoup(f);
        var cost = c.getCost().sub(recoup);
        var afford = cost.le(state.res);
        var text = keyname + '+' + verb + '<br>' + upper(c.name);
        if(!selecting) text += '<br>' + (afford ? '' : '<font color="#888">') + 'Cost: ' + cost + ' (' + getCostAffordTimer(cost) + ')' + (afford ? '' : '</font>');
        textFlex.div.textEl.innerHTML = text;
      };
      updatefun();
      registerUpdateListener(function() {
        if((!cropChipShiftDown && !cropChipCtrlDown) || !shiftCropFlexShowing) return false;
        updatefun();
        return true;
      });
    } else {
      textFlex.div.textEl.innerHTML = keyname + '+' + verb + '<br><br>' + 'none set';
    }
  }

  addButtonAction(shiftCropFlex.div, removeShiftCropChip);
}

function updateFieldMouseOver(x, y) {
  shiftCropFlexX = x;
  shiftCropFlexY = y;
  if(shiftCropFlexShowing) showShiftCropChip(shiftCropFlexId);
}

function updateFieldMouseOut(x, y) {
  if(x == shiftCropFlexX && y == shiftCropFlexY) updateFieldMouseOver(-1, -1);
}

function updateFieldMouseClick(x, y) {
  updateFieldMouseOver(x, y);
}


////////////////////////////////////////////////////////////////////////////////


// the "shift+plant" chip at the bottom
var shiftCrop2Flex = undefined;
var shiftCrop2FlexId;
var shiftCrop2FlexX = -1;
var shiftCrop2FlexY = -1;
var shiftCrop2FlexShowing;

function removeShiftCrop2Chip() {
  shiftCrop2FlexShowing = false;

  if(!shiftCrop2Flex) return;

  shiftCrop2Flex.removeSelf(gameFlex);
  shiftCrop2Flex = undefined;
}

function showShiftCrop2Chip(crop_id) {
  removeShiftCrop2Chip();
  var shift = cropChipShiftDown;
  var ctrl = cropChipCtrlDown;
  if(!shift && !ctrl) return;

  var c = crop_id >= 0 ? crops2[crop_id] : undefined;

  shiftCrop2FlexShowing = true; // even when invisible due to not mouse over relevant field tile

  shiftCrop2FlexId = crop_id;

  var x = shiftCrop2FlexX;
  var y = shiftCrop2FlexY;

  var f;
  if(x < 0 || y < 0 || x == undefined || y == undefined) f = new Cell(undefined, undefined, 2); // fake empty field cell to make it indicate "planting"
  else f = state.field2[y][x];

  var planting = !f.hasCrop(); // using !f.hasCrop(), rather than f.isEmpty(), to also show the planting chip when mouse is over the tree, rather than showing nothing then, to give the information in more places no matter where the mouse is
  var deleting = f.hasCrop() && ctrl && !shift;
  var replacing = f.hasCrop() && shift && !ctrl;
  //if(replacing && f.getCrop().index == state.lastPlanted) replacing = false; // replacing does not work if same crop. It could be deleting, or nothing, depending on plant growth, but display as nothing
  var upgrading = f.hasCrop() && shift && ctrl && f.getCrop().tier < state.highestoftype2unlocked[f.getCrop().type];
  if(upgrading) c = croptype2_tiers[f.getCrop().type][state.highestoftype2unlocked[f.getCrop().type]];
  var selecting = f.hasCrop() && shift && ctrl && f.getCrop().tier >= state.highestoftype2unlocked[f.getCrop().type];
  if(selecting) c = f.getCrop();

  if(!planting && !deleting && !replacing && !upgrading && !selecting) return;
  if(planting && !deleting && !replacing && !upgrading && !selecting && crop_id == undefined) return;

  var keyname = (shift ? (ctrl ? 'Shift+ctrl' : 'Shift') : 'Ctrl');
  var verb = planting ? 'planting' : (deleting ? 'deleting' : (replacing ? 'replacing' : (selecting ? 'selecting' : 'upgrading')));


  shiftCrop2Flex = new Flex(gameFlex, 0.2, 0.85, 0.8, 0.95);
  shiftCrop2Flex.div.style.backgroundColor = planting ? '#dfd' : (deleting ? '#fdd' : '#ffd');
  shiftCrop2Flex.div.style.zIndex = 100; // above medal chip

  var textFlex = new Flex(shiftCrop2Flex, [0, 0, 0.0], [0.5, 0, -0.35], 0.99, [0.5, 0, 0.35]);
  //textFlex.div.style.color = '#fff';
  textFlex.div.style.color = '#000';
  centerText2(textFlex.div);

  if(deleting) {
    var recoup = f.getCrop().getCost(-1).mulr(cropRecoup2);
    textFlex.div.textEl.innerHTML = keyname + '+' + verb + '<br><br>recoup: ' + recoup.toString();
  } else {
    if(c) {
      var canvasFlex = new Flex(shiftCrop2Flex, 0.01, [0.5, 0, -0.35], [0, 0, 0.7], [0.5, 0, 0.35]);
      var canvas = createCanvas('0%', '0%', '100%', '100%', canvasFlex.div);
      renderImage(c.image[4], canvas);
      var updatefun = function() {
        var recoup = Res(0);
        if(f.hasCrop()) recoup = f.getCrop().getCost(-1).mulr(cropRecoup2);
        var cost = c.getCost().sub(recoup);
        var afford = cost.le(state.res);
        var text = keyname + '+' + verb + '<br>' + upper(c.name);
        if(!selecting) text += '<br>' + (afford ? '' : '<font color="#888">') + 'Cost: ' + cost + ' (' + getCostAffordTimer(cost) + ')' + (afford ? '' : '</font>');
        textFlex.div.textEl.innerHTML = text;
      };
      updatefun();
      registerUpdateListener(function() {
        if((!cropChipShiftDown && !cropChipCtrlDown) || !shiftCrop2FlexShowing) return false;
        updatefun();
        return true;
      });
    } else {
      textFlex.div.textEl.innerHTML = keyname + '+' + verb + '<br><br>' + 'none set';
    }
  }

  addButtonAction(shiftCrop2Flex.div, removeShiftCrop2Chip);
}

function updateField2MouseOver(x, y) {
  shiftCrop2FlexX = x;
  shiftCrop2FlexY = y;
  if(shiftCrop2FlexShowing) showShiftCrop2Chip(shiftCrop2FlexId);
}

function updateField2MouseOut(x, y) {
  if(x == shiftCrop2FlexX && y == shiftCrop2FlexY) updateField2MouseOver(-1, -1);
}

function updateField2MouseClick(x, y) {
  updateField2MouseOver(x, y);
}

////////////////////////////////////////////////////////////////////////////////


// the "shift+plant" chip at the bottom
var shiftCrop3Flex = undefined;
var shiftCrop3FlexId;
var shiftCrop3FlexX = -1;
var shiftCrop3FlexY = -1;
var shiftCrop3FlexShowing;

function removeShiftCrop3Chip() {
  shiftCrop3FlexShowing = false;

  if(!shiftCrop3Flex) return;

  shiftCrop3Flex.removeSelf(gameFlex);
  shiftCrop3Flex = undefined;
}

function showShiftCrop3Chip(crop_id) {
  removeShiftCrop3Chip();
  var shift = cropChipShiftDown;
  var ctrl = cropChipCtrlDown;
  if(!shift && !ctrl) return;

  var c = crop_id >= 0 ? crops3[crop_id] : undefined;

  shiftCrop3FlexShowing = true; // even when invisible due to not mouse over relevant field tile

  shiftCrop3FlexId = crop_id;

  var x = shiftCrop3FlexX;
  var y = shiftCrop3FlexY;

  var f;
  if(x < 0 || y < 0 || x == undefined || y == undefined) f = new Cell(undefined, undefined, 3); // fake empty field cell to make it indicate "planting"
  else f = state.field3[y][x];

  var planting = !f.hasCrop(); // using !f.hasCrop(), rather than f.isEmpty(), to also show the planting chip when mouse is over the tree, rather than showing nothing then, to give the information in more places no matter where the mouse is
  var deleting = f.hasCrop() && ctrl && !shift;
  var replacing = f.hasCrop() && shift && !ctrl;
  //if(replacing && f.getCrop().index == state.lastPlanted) replacing = false; // replacing does not work if same crop. It could be deleting, or nothing, depending on plant growth, but display as nothing
  var upgrading = f.hasCrop() && shift && ctrl && f.getCrop().tier < state.highestoftype3unlocked[f.getCrop().type];
  if(upgrading) c = croptype3_tiers[f.getCrop().type][state.highestoftype3unlocked[f.getCrop().type]];
  var selecting = f.hasCrop() && shift && ctrl && f.getCrop().tier >= state.highestoftype3unlocked[f.getCrop().type];
  if(selecting) c = f.getCrop();

  if(!planting && !deleting && !replacing && !upgrading && !selecting) return;

  var keyname = (shift ? (ctrl ? 'Shift+ctrl' : 'Shift') : 'Ctrl');
  var verb = planting ? 'planting' : (deleting ? 'deleting' : (replacing ? 'replacing' : (selecting ? 'selecting' : 'upgrading')));


  shiftCrop3Flex = new Flex(gameFlex, 0.2, 0.85, 0.8, 0.95);
  shiftCrop3Flex.div.style.backgroundColor = planting ? '#dfd' : (deleting ? '#fdd' : '#ffd');
  shiftCrop3Flex.div.style.zIndex = 100; // above medal chip

  var textFlex = new Flex(shiftCrop3Flex, [0, 0, 0.0], [0.5, 0, -0.35], 0.99, [0.5, 0, 0.35]);
  //textFlex.div.style.color = '#fff';
  textFlex.div.style.color = '#000';
  centerText2(textFlex.div);

  if(deleting) {
    var recoup = f.getCrop().getCost(-1).mulr(cropRecoup3);
    textFlex.div.textEl.innerHTML = keyname + '+' + verb + '<br><br>recoup: ' + recoup.toString();
  } else {
    if(c) {
      var canvasFlex = new Flex(shiftCrop3Flex, 0.01, [0.5, 0, -0.35], [0, 0, 0.7], [0.5, 0, 0.35]);
      var canvas = createCanvas('0%', '0%', '100%', '100%', canvasFlex.div);
      renderImage(c.image[4], canvas);
      var updatefun = function() {
        var recoup = Res(0);
        if(f.hasCrop()) recoup = f.getCrop().getCost(-1).mulr(cropRecoup3);
        var cost = c.getCost().sub(recoup);
        var afford = cost.le(state.res);
        var text = keyname + '+' + verb + '<br>' + upper(c.name);
        if(!selecting) text += '<br>' + (afford ? '' : '<font color="#888">') + 'Cost: ' + cost + ' (' + getCostAffordTimer(cost) + ')' + (afford ? '' : '</font>');
        textFlex.div.textEl.innerHTML = text;
      };
      updatefun();
      registerUpdateListener(function() {
        if((!cropChipShiftDown && !cropChipCtrlDown) || !shiftCrop3FlexShowing) return false;
        updatefun();
        return true;
      });
    } else {
      textFlex.div.textEl.innerHTML = keyname + '+' + verb + '<br><br>' + 'none set';
    }
  }

  addButtonAction(shiftCrop3Flex.div, removeShiftCrop3Chip);
}

function updateField3MouseOver(x, y) {
  shiftCrop3FlexX = x;
  shiftCrop3FlexY = y;
  if(shiftCrop3FlexShowing) showShiftCrop3Chip(shiftCrop3FlexId);
}

function updateField3MouseOut(x, y) {
  if(x == shiftCrop3FlexX && y == shiftCrop3FlexY) updateField3MouseOver(-1, -1);
}

function updateField3MouseClick(x, y) {
  updateField3MouseOver(x, y);
}

////////////////////////////////////////////////////////////////////////////////

var cropChipShiftDown = false;
var cropChipCtrlDown = false;

function showCropChips() {
  // Show plant that will be planted when holding down shift or ctrl or cmd, but
  // only if in the field tab and no dialogs are visible
  if(state.currentTab == tabindex_field && dialog_level == 0) {
    var plant = cropChipShiftDown ? state.lastPlanted : getHighestBrassica();
    showShiftCropChip(plant);
  }
  if(state.currentTab == tabindex_field2 && dialog_level == 0) {
    var plant = cropChipShiftDown ? state.lastPlanted2 : undefined;
    showShiftCrop2Chip(plant);
  }
  if(state.currentTab == tabindex_field3 && dialog_level == 0) {
    var plant = cropChipShiftDown ? state.lastPlanted3 : getHighestAffordableBrassica3();
    showShiftCrop3Chip(plant);
  }
}

// some keys here are not related to abilities, this function handles all global keys for now
document.addEventListener('keydown', function(e) {
  if(e.key == 'Shift' || e.key == 'Control' || e.key == 'Meta') {
    if(e.key == 'Shift') cropChipShiftDown = true;
    if(e.key == 'Control' || e.key == 'Meta') cropChipCtrlDown = true;
    showCropChips();
    removeAllTooltips();
  }
});

document.addEventListener('keyup', function(e) {
  if(e.key == 'Shift' || e.key == 'Control' || e.key == 'Meta') {
    if(e.key == 'Shift') cropChipShiftDown = false;
    if(e.key == 'Control' || e.key == 'Meta') cropChipCtrlDown = false;
    if(!cropChipShiftDown && !cropChipCtrlDown) {
      removeShiftCropChip();
      removeShiftCrop2Chip();
      removeShiftCrop3Chip();
    } else {
      showCropChips();
    }
  }
});

// if keyup happens outside of window, ctrl or shift up are not detected, reset the chips then too to avoid leftover chips while shift or ctrl are not down (e.g. when using some ctrl shortcut that goes to another window in the OS)
window.addEventListener('blur', function(e) {
  cropChipShiftDown = false;
  cropChipCtrlDown = false;

  removeShiftCropChip();
  removeShiftCrop2Chip();
  removeShiftCrop3Chip();
});


////////////////////////////////////////////////////////////////////////

var automatonIgnoredUpgradeChipFlex = undefined;

function removeAutomatonIgnoredUpgradeChip() {
  if(!automatonIgnoredUpgradeChipFlex) return;

  automatonIgnoredUpgradeChipFlex.removeSelf(gameFlex);
  automatonIgnoredUpgradeChipFlex = undefined;
}

function showAutomatonIgnoredUpgradeChip(upgrade_index) {
  var u = upgrades[upgrade_index];
  removeAutomatonIgnoredUpgradeChip();

  automatonIgnoredUpgradeChipFlex = new Flex(gameFlex, 0.1, 0.73, 0.9, 0.97);
  automatonIgnoredUpgradeChipFlex.div.style.backgroundColor = '#ffdf';
  automatonIgnoredUpgradeChipFlex.div.style.border = '2px solid red';

  var canvasFlex = new Flex(automatonIgnoredUpgradeChipFlex, 0.01, [0.5, 0, -0.35], [0, 0, 0.7], [0.5, 0, 0.35]);
  var canvas = createCanvas('0%', '0%', '100%', '100%', canvasFlex.div);
  if(u.image0) renderImage(u.image0, canvas);

  var textFlex = new Flex(automatonIgnoredUpgradeChipFlex, [0, 0, 0.7], [0.5, 0, -0.45], 0.99, [0.5, 0, 0.45]);
  //textFlex.div.style.color = '#fff';
  textFlex.div.style.color = '#000';
  textFlex.div.innerHTML = 'Notice: Automaton did not buy the following new upgrade that could be afforded before auto-trancend, because it must be performed manually at least once first: ' + '<br><br>' + upper(u.name) + '<br><br>To ensure this upgrade can get used automatically, buy it manually before auto-transcend activates next time, or disable auto-transcend for a while.';

  registerAction(automatonIgnoredUpgradeChipFlex.div, removeAutomatonIgnoredUpgradeChip, 'close message chip', {
    short_only: true
  });
}

////////////////////////////////////////////////////////////////////////

var autoTranscendMissedGoodFruitChipFlex = undefined;

function removeAutoTranscendMissedGoodFruitChip() {
  if(!autoTranscendMissedGoodFruitChipFlex) return;

  autoTranscendMissedGoodFruitChipFlex.removeSelf(gameFlex);
  autoTranscendMissedGoodFruitChipFlex = undefined;
}

function showAutoTranscendMissedGoodFruitChip() {
  removeAutoTranscendMissedGoodFruitChip();

  autoTranscendMissedGoodFruitChipFlex = new Flex(gameFlex, 0.1, 0.73, 0.9, 0.97);
  autoTranscendMissedGoodFruitChipFlex.div.style.backgroundColor = '#ffdf';
  autoTranscendMissedGoodFruitChipFlex.div.style.border = '2px solid red';

  var canvasFlex = new Flex(autoTranscendMissedGoodFruitChipFlex, 0.01, [0.5, 0, -0.35], [0, 0, 0.7], [0.5, 0, 0.35]);
  var canvas = createCanvas('0%', '0%', '100%', '100%', canvasFlex.div);
  renderImage(images_apple[0], canvas);

  var textFlex = new Flex(autoTranscendMissedGoodFruitChipFlex, [0, 0, 0.7], [0.5, 0, -0.45], 0.99, [0.5, 0, 0.45]);
  //textFlex.div.style.color = '#fff';
  textFlex.div.style.color = '#000';
  textFlex.div.innerHTML = 'Notice: Auto-transcend happened while a next-tier fruit dropped! You may still be able to collect it with "Recover sacrified fruit", which you can find at the bottom of the fruits tab. To more efficiently collect next-tier fruits, consider doing transcend manually for a while.';

  registerAction(autoTranscendMissedGoodFruitChipFlex.div, removeAutoTranscendMissedGoodFruitChip, 'close message chip', {
    short_only: true
  });
}
