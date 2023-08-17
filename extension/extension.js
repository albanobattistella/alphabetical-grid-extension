/* exported ExtensionManager */

//Local imports
import * as AppGridHelper from './lib/AppGridHelper.js';

//Main imports
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';

//Extension system imports
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

//Access required objects and systems
const AppDisplay = AppGridHelper.AppDisplay;
const Controls = Main.overview._overview._controls;

var loggingEnabled = false;
function logMessage(message) {
  if (loggingEnabled) {
    let date = new Date();
    let timestamp = date.toTimeString().split(' ')[0];
    log('alphabetical-app-grid [' + timestamp + ']: ' + message);
  }
}

export default class ExtensionManager extends Extension {
  enable() {
    this._gridReorder = new AppGridExtension(this.getSettings());
    loggingEnabled = this._gridReorder._extensionSettings.get_boolean('logging-enabled');

    //Patch shell, reorder and trigger listeners
    AppDisplay._redisplay();
    this._gridReorder.patchShell();
    this._gridReorder.startListeners();
    this._gridReorder.reorderGrid('Reordering app grid');
  }

   disable() {
    //Disconnect from events and clean up
    this._gridReorder.disconnectListeners();
    this._gridReorder.unpatchShell();

    this._gridReorder = null;
  }
}

class AppGridExtension {
  constructor(extensionSettings) {
    this._injectionManager = new InjectionManager();

    this._extensionSettings = extensionSettings;
    this._shellSettings = new Gio.Settings({schema: 'org.gnome.shell'});
    this._folderSettings = new Gio.Settings({schema: 'org.gnome.desktop.app-folders'});

    //Create a lock to prevent code triggering multiple reorders at once
    this._currentlyUpdating = false;
  }

  patchShell() {
    //Patched version of _compareItems(), to apply custom order
    let extensionSettings = this._extensionSettings;
    let folderSettings = this._folderSettings;
    function _patchedCompareItems(a, b) {
      let folderPosition = extensionSettings.get_string('folder-order-position');
      let folderArray = folderSettings.get_value('folder-children').get_strv();
      return AppGridHelper.compareItems.call(this, a, b, folderPosition, folderArray);
    }

    //Patch the internal functions
    this._injectionManager.overrideMethod(AppDisplay, '_compareItems', () => {
      return _patchedCompareItems.bind(AppDisplay);
    });
    logMessage('Patched item comparison');

    this._injectionManager.overrideMethod(AppDisplay, '_redisplay', () => {
      return AppGridHelper.reloadAppGrid.bind(AppDisplay);
    });
    logMessage('Patched redisplay');
  }

  unpatchShell() {
    //Unpatch the internal functions for extension shutdown
    this._injectionManager.clear();
    logMessage('Unpatched item comparison');
    logMessage('Unpatched redisplay');
  }

  //Helper functions

  reorderGrid(logText) {
    //Detect lock to avoid multiple changes at once
    if (!this._currentlyUpdating && !AppDisplay._pageManager._updatingPages) {
      this._currentlyUpdating = true;
      logMessage(logText);

      //Alphabetically order the contents of each folder, if enabled
      if (this._extensionSettings.get_boolean('sort-folder-contents')) {
        logMessage('Reordering folder contents');
        AppGridHelper.reorderFolderContents();
      }

      //Wait a small amount of time to avoid clashing with animations
      this._reorderGridTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        //Redisplay the app grid and release the lock
        AppDisplay._redisplay();
        this._currentlyUpdating = false;
        this._reorderGridTimeoutId = null;
        return GLib.SOURCE_REMOVE;
      });
    }
  }

  //Listener functions below

  startListeners() {
    //Persistent listeners
    this._waitForGridReorder();
    this._waitForFavouritesChange();
    this._waitForSettingsChange();
    this._waitForInstalledAppsChange();
    this._waitForFolderChange();

    //One time connections
    this._reorderOnDisplay();

    logMessage('Connected to listeners');
  }

  disconnectListeners() {
    this._shellSettings.disconnect(this._reorderSignal);
    Main.overview.disconnect(this._dragReorderSignal);
    this._shellSettings.disconnect(this._favouriteAppsSignal);
    this._extensionSettings.disconnect(this._settingsChangedSignal);
    Shell.AppSystem.get_default().disconnect(this._installedAppsChangedSignal);
    this._folderSettings.disconnect(this._foldersChangedSignal);

    if (this._reorderOnDisplaySignal != null) {
      Controls._stateAdjustment.disconnect(this._reorderOnDisplaySignal);
    }

    //Clean up timeout sources
    if (this._reorderGridTimeoutId != null) {
      GLib.Source.remove(this._reorderGridTimeoutId);
    }

    logMessage('Disconnected from listeners');
  }

  _waitForGridReorder() {
    //Connect to gsettings and wait for the order to change
    this._reorderSignal = this._shellSettings.connect('changed::app-picker-layout', () => {
      this.reorderGrid('App grid layout changed, triggering reorder');
    });

   //Connect to the main overview and wait for an item to be dragged
    this._dragReorderSignal = Main.overview.connect('item-drag-end', () => {
      this.reorderGrid('App movement detected, triggering reorder');
    });
  }

  _reorderOnDisplay() {
    //Reorder when the app grid is opened
    this._reorderOnDisplaySignal = Controls._stateAdjustment.connect('notify::value', () => {
      if (Controls._stateAdjustment.value == OverviewControls.ControlsState.APP_GRID) {
        this.reorderGrid('App grid opened, triggering reorder');
      }
    });
  }

  _waitForFavouritesChange() {
    //Connect to gsettings and wait for the favourite apps to change
    this._favouriteAppsSignal = this._shellSettings.connect('changed::favorite-apps', () => {
      this.reorderGrid('Favourite apps changed, triggering reorder');
    });
  }

  _waitForSettingsChange() {
    //Connect to gsettings and wait for the extension's settings to change
    this._settingsChangedSignal = this._extensionSettings.connect('changed', () => {
      loggingEnabled = this._extensionSettings.get_boolean('logging-enabled');
      this.reorderGrid('Extension gsettings values changed, triggering reorder');
    });
  }

  _waitForFolderChange() {
    //If a folder was made or deleted, trigger a reorder
    this._foldersChangedSignal = this._folderSettings.connect('changed::folder-children', () => {
      this.reorderGrid('Folders changed, triggering reorder');
    });
  }

  _waitForInstalledAppsChange() {
    //Wait for installed apps to change
    this._installedAppsChangedSignal = Shell.AppSystem.get_default().connect('installed-changed', () => {
      this.reorderGrid('Installed apps changed, triggering reorder');
    });
  }
}
