/* Ethereal Farm — GPL-3.0-or-later; see LICENSE. */

// An explicit presentation adapter, NOT a DOM emulator. Unknown dependencies
// remain undefined and fail loudly. No UI scripts or browser storage are loaded.
// Keep raw pixel arrays because content registration still refers to artwork;
// no canvas is allocated and no rendering takes place.
function setupImage(image) { return image; }
function generateAndSetupImage(text) { return generateImage(text); }

// A new ambient RNG call must be wired through gameRuntime, not silently make
// replay depend on process randomness. This only affects this private context.
Math.random = function() { throw new Error('Use gameRuntime.random in simulation code'); };

var showingSidePanel = false;
var showing_help = false;
var showing_changelog = false;
var showing_stats = false;
var showing_challenge_stats = false;
var showing_transcension_stats = false;
var showing_automaton_dialog = false;
var showing_fruit_dialog = false;
var showing_old_squirrel_dialog = false;
var showing_previous_unlocks_dialog = false;
var helpNeverAgainLocal = {};
var GOAL_NONE = 0;
var prevGoal = GOAL_NONE;
var prevGoalSubCode = 0;
var showingConfigureAutoActionDialog = false;
var showingConfigureAutoChoiceDialog = false;
var aboutButtonCanvas_lastHoliday = -1;
var lastTouchedFruit;

function showMessage(text, category) {
  gameRuntime.emit({kind: 'message', text: text, category: category || 0});
}

function showHelpDialog(id) {
  state.help_seen_text[Math.abs(id)] = Math.abs(id);
  if(id > 0) state.help_seen[id] = id;
  gameRuntime.emit({kind: 'help', id: id});
  return false;
}
function showRegisteredHelpDialog(id) { return showHelpDialog(id); }
function unlockRegisteredHelpDialog(id) { state.help_seen_text[id] = id; }
function showFruitChip(text) { showMessage(text, C_NATURE); }

// These hooks only redraw, show notifications, or dismiss presentation elements.
// Gameplay helpers (notably fruit placement heuristics) are shared, not stubbed.
function initFieldUI() {}
function initField2UI() {}
function initField3UI() {}
function initInfoUI() {}
function updateUI2() {}
function updateFruitUI() {}
function updateAmberUI() {}
function updateMedalUI() {}
function updateAbilitiesUI() {}
function updateSquirrelUI() {}
function updateRightPane() {}
function updateUndoButtonText() {}
function showGoalChips() {}
function showMedalChip() {}
function showChallengeChip() {}
function showchallengeUnlockedChip() {}
function showEtherealTreeLevelDialog() {}
function removeChallengeChip() {}
function removeMedalChip() {}
function removeHelpChip() {}
function removeAllDropdownElements() {}
function playNotificationSound() {}
function shouldShowSidePanel() { return false; }
function setTab(tab) { state.currentTab = tab; }
