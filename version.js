/**
 * Single source of truth for the app version.
 * Loaded as a classic script by index.html (window.VALU_VERSION) and by the service worker
 * (importScripts). Bump this ONE value on every deploy: it renames the offline cache and updates
 * the label in the side menu.
 */
(function (root) {
  root.VALU_VERSION = 'v23';
})(typeof self !== 'undefined' ? self : this);
