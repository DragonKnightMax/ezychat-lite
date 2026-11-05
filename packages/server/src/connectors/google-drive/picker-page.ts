/**
 * Google's file picker for Google Drive, on a page this server serves only to this computer
 * (`/api/connectors/google-drive/picker-page`), like the Google Sheets picker: the app window's CSP
 * never loads outside scripts, so the picker opens in the system browser. Two modes from the
 * one-time picker session: `folder` (pick one folder) and `files` (pick several files, opened in
 * the agent's folder). Picking is what grants EzyChat access (`drive.file`). No inline script.
 *
 * Untested against real Google in CI: tests and `--fake-wa` use the fake picker page instead.
 */
export { PICKER_PAGE_CSP } from '../google-sheets/picker-page.js';

export const DRIVE_PICKER_PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Choose from Google Drive</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1f2933}</style><script src="/api/connectors/google-drive/picker.js" defer></script></head><body><h1>Choose from Google Drive</h1><p id="status">Opening Google's file picker…</p></body></html>`;

/** The page's script (served as JavaScript from this server). */
export const DRIVE_PICKER_SCRIPT = `/* EzyChat: Google's file picker for Google Drive */
(function () {
  var token = new URLSearchParams(location.search).get('token') || '';
  var status = document.getElementById('status');
  var say = function (text) { status.textContent = text; };
  var send = function (body) {
    body.token = token;
    return fetch('/api/connectors/google-drive/picker-result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  };
  fetch('/api/connectors/google-drive/picker-config?token=' + encodeURIComponent(token))
    .then(function (res) {
      if (!res.ok) throw new Error('expired');
      return res.json();
    })
    .then(function (cfg) {
      var script = document.createElement('script');
      script.src = 'https://apis.google.com/js/api.js';
      script.onerror = function () { say('Google could not be reached. Try again from EzyChat.'); };
      script.onload = function () {
        window.gapi.load('picker', function () {
          var picker = window.google.picker;
          var builder = new picker.PickerBuilder()
            .setAppId(cfg.appId)
            .setOAuthToken(cfg.oauthToken)
            .setDeveloperKey(cfg.developerKey)
            .setOrigin(location.origin);
          if (cfg.mode === 'folder') {
            builder.addView(
              new picker.DocsView(picker.ViewId.FOLDERS)
                .setIncludeFolders(true)
                .setSelectFolderEnabled(true)
                .setMimeTypes('application/vnd.google-apps.folder'),
            );
          } else {
            var view = new picker.DocsView(picker.ViewId.DOCS).setMode(picker.DocsViewMode.LIST);
            if (cfg.parent) view.setParent(cfg.parent);
            builder.addView(view).enableFeature(picker.Feature.MULTISELECT_ENABLED).setMaxItems(cfg.maxItems);
          }
          builder
            .setCallback(function (data) {
              if (data.action === picker.Action.PICKED && data.docs && data.docs.length) {
                say('Checking with Google…');
                send({ ids: data.docs.map(function (d) { return d.id; }) }).then(function (res) {
                  say(res.ok ? 'Done. Close this window and return to EzyChat.' : 'EzyChat could not open that. Try again from EzyChat.');
                });
              } else if (data.action === picker.Action.CANCEL) {
                send({ cancelled: true });
                say('Cancelled. You can close this window.');
              }
            })
            .build()
            .setVisible(true);
        });
      };
      document.head.appendChild(script);
    })
    .catch(function () { say('This link expired. Choose again from EzyChat.'); });
})();
`;
