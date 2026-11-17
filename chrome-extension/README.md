# Ethereal Farm Speed & Run Charts

An unpacked Chrome Manifest V3 extension with an in-game **1×, 10×, 20×, …, 100×** slider (11 positions, 10 intervals). Includes live run charts. No build step or runtime dependencies.

## Install

1. In Ethereal Farm, export a backup through the game's save settings.
2. Open `chrome://extensions` in Chrome and turn on **Developer mode**.
3. Click **Load unpacked** and select this `chrome-extension` directory.
4. Reload <https://lodev.org/etherealfarm/>. The compact speed slider appears above the upgrades column.
5. Select a speed. The leftmost **1×** position returns to normal speed; **+** opens speed details; **−** closes them.
6. Use **`,` / `<`** to decrease speed and **`.` / `>`** to increase it one slider position. Shortcuts ignore text inputs, editable fields and Ctrl/Alt/Command combinations.

Local development is supported at `http://localhost` and `http://127.0.0.1` on any port. For example, run `python3 -m http.server 8080` from the repository root, then open `http://localhost:8080/`. The toolbar only mounts on pages whose title contains “Ethereal Farm”.

## Run charts

Reload the extension in `chrome://extensions`, then reload the game to apply an update. Version 0.3.0 introduced the `storage` permission for local chart history.

The dashboard occupies available space to the right of the field/upgrades without resizing or restyling the game. When there is less than 340 px available, use **Run charts ↗** to open a drawer. The panel fills the viewport height with 10 px top/bottom margins, and the three charts share the available height evenly. Short windows scroll independently. Version 0.3.1 places a compact speed slider above the upgrades column and removes the seeds/spores charts.

- Dark slate panels, light labels, green current-run lines and dashed blue comparison lines.
- Three charts: resin/hour, tree level, twigs/hour.
- Solid green is current; dashed blue is the previous or selected recorded run. Hover aligns the cursor across all charts and shows actual recorded values and sample times. Tree levels use steps.
- Simple vertical power markers only: yellow Sun, blue Mist, purple Rainbow. They represent successful activations (including automatic ones), not attempted clicks. No event banners or shaded bands.
- The time axis uses the game's active run time, so speed settings and pauses are accounted for by the game itself. Resin/hour and twigs/hour call the game's own calculations; resin excludes fern rewards, just like the game's displayed rate.
- Raw large numbers retain the game's mantissa/exponent exactly. Labels use game formatting; charts offer linear or signed logarithmic display (zero/negative values are supported).
- Recordings start when installed. Earlier unobserved history is not reconstructed. Refresh/background gaps are marked as breaks in lines. A reset, changed run identity, or backward game timeline starts a separate segment; undo/import or reloading an older game save can therefore create a new segment.
- The latest 10 recorded runs/segments are retained, with at most 1,200 samples each (older samples progressively thinned) and 1,000 power events each. Values at retained points are actual observations; intervening simulation steps are not reconstructed.
- History is saved every five real seconds and on hide/exit through Chrome extension storage, separate from game saves. A sudden crash can lose the latest unsaved seconds. Removing the extension deletes its chart history. The game and chart saves are independent, so an older restored game save is shown as a separate timeline.
- Only one tab per game path records at a time. Reload a secondary tab after closing the recording tab to take over. If extension storage fails, the panel reports that history is in memory only.
- Supported adapters: this source checkout and the published **v0.18.5** game. Unknown builds display an unsupported-version message rather than guessing values.

## Behavior and save compatibility

- The extension scales `Date.now()` in the game page from document start. The published minified game and this repository both read this clock for simulation. Browser timer scheduling and animation frame timing remain unchanged.
- Game rules calculate the resulting production, growth, seasons and cooldowns. The game normally drops manual actions during catch-up ticks longer than two game seconds. Before pointer or keyboard input reaches the game, the extension drains pending simulation and holds acceleration for one second so manual actions can process. Acceleration then resumes automatically; repeated input extends the hold. The selected multiplier is a target while idle; actual processing depends on the farm and computer.
- Reloading or switching tabs resets the selected rate to **1×**. Extra time from any single clock-read gap is capped at one real second to avoid multiplying laptop sleep or long browser stalls.
- The accumulated clock offset is saved in this site's local storage, separately for each URL pathname. This lets accelerated saves reload without moving the clock backward. Closing the game adds ordinary offline time, not multiplied offline time.
- **Keep the extension enabled when using accelerated saves, and use one game tab at a time.** Disabling it, clearing its storage, changing the URL path, or moving a save to another browser removes the clock offset. The game can then record negative time and reduce later offline gains. Selecting 1× stops further acceleration; it does not undo progress or remove the offset. To return to an unmodified timeline, disable the extension and restore your original backup.
- Storage failures disable acceleration. No account, server, analytics, or external requests are used.

## Verification

Run `node --test chrome-extension/*.test.mjs` from the repository root. Tests execute the real game simulation at all 11 rates, including manual planting with pending accelerated time and check speed transitions, reload continuity, background handling, suspension caps and storage failures. A headless Chrome smoke check against the published game verified toolbar rendering, all four shortcut keys, text-input exclusion and manual planting at 100× with no page errors. This injected the same scripts at document start; unpacked-extension installation remains a manual check. The interaction adapter supports this repository and the published v0.18.5 build; an unrecognized published version disables the slider until its adapter is verified. Very large offline backlogs may still require the game to finish computing before interaction.

Chrome content script architecture: <https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts>.

License: GPL-3.0-or-later, as in the parent repository.

### Browser integration check

`browser-smoke.cjs` uses Playwright and installed Chrome in a fresh browser context; it never opens your Chrome profile. Install Playwright in a separate test directory and set `NODE_PATH` to its `node_modules`, then run `node chrome-extension/browser-smoke.cjs`. It injects the actual extension scripts and substitutes only the Chrome storage API; the game is the published build. The test checks layout bounds, exact value equality, planting at 100×, successful Sun/Mist/Rainbow actions, real game reset, history reload, and narrow-screen layout. It unlocks weather powers only in its disposable test farm. Unpacked-extension permission/installation remains a manual check.
