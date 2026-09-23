/**
 * src/ui — gothic UI screens (spec §39, §40). Public API surface:
 *
 * Screens (DOM-free; Wave 5 built the full set — headless controllers in
 * src/ui/screens/, Phaser renderers paired alongside):
 *   TitleScreen    title / New Game / Continue / Load / Settings / Credits
 *                  — shows version 'v0.1.0 ALPHA' unobtrusively (spec §61)
 *   HUD            HP/MP bars, XP bar + level, currency, quick-use
 *                  indicator, boss bar, room-name banner, prompts
 *   PauseMenu      resume / inventory / map / settings / save / quit-to-title
 *   InventoryScreen  tabs: STATUS | ITEMS | EQUIP | MAGIC | MAP | BESTIARY | SAVE | CONFIG
 *   MapScreen        renders src/map/MapModel (MapOverlay)
 *   DialogueBox      typewriter text, name plate, choices; merchants chain
 *                    into the shop (NpcDirector + DialogueController)
 *   ShopScreen       Merchant buy/sell/compare (ShopController)
 *   SaveScreen       slots 1-3 (inventory SAVE tab), export/import (SaveManager)
 *   SettingsScreen   per-channel volume sliders (inventory CONFIG tab)
 *   EndScreens       game-over (respawn/last-save/title) and post-Matriarch
 *                    victory (continue-after-credits/title)
 *   ControlsScreen   bindings table, device-aware prompts (InputManager.getPrompt)
 *   TouchOverlay     virtual controls; hidden unless device == touch (spec §41)
 *   LoadingIndicator shown when AssetManager stage load > 400ms
 *
 * CONTRACT:
 * - All screens fully operable with controller (spec §13): focus navigation
 *   via move_up/move_down/confirm/cancel/menu_tab_next/menu_tab_prev actions.
 * - Pause coordination: opening any full screen pauses the GameScene;
 *   closing resumes ONLY if no other screen is open (pause ref-count).
 * - Emits 'ui:opened' / 'ui:closed' { screen }.
 * - Responsive: anchored layouts, safe-area padding, no critical controls
 *   under browser UI (spec §40).
 * - ORIGINAL gothic visual design — do not imitate Castlevania's UI.
 */
export const UiScreens = Object.freeze([
  'title', 'hud', 'pause', 'inventory', 'map', 'dialogue',
  'shop', 'save', 'settings', 'controls', 'credits', 'touch',
  'gameover', 'victory',
]);
