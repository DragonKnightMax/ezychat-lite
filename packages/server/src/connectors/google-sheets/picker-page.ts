/**
 * Google's file picker for Google Sheets, on a page this server serves only to this computer
 * (`/api/connectors/google-sheets/picker-page`): the app window's CSP never loads outside scripts,
 * so the picker opens in the system browser like the Google sign-in. The page loads Google's
 * picker library, asks this server for a fresh access token (one-time picker session, host-only)
 * and posts the picked spreadsheet id back. No inline script: its code is `picker.js`.
 *
 * Untested against real Google in CI: tests and `--fake-wa` use the fake picker page instead.
 */

/** The page's own CSP: Google's picker scripts and frames only, nothing else outside. */
export const PICKER_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self' https://apis.google.com https://www.gstatic.com",
  "style-src 'unsafe-inline' https://fonts.googleapis.com https://www.gstatic.com",
  'font-src https://fonts.gstatic.com',
  'img-src https: data:',
  "connect-src 'self' https://*.googleapis.com https://*.google.com",
  'frame-src https://docs.google.com https://drive.google.com https://accounts.google.com https://content.googleapis.com',
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const PICKER_PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Choose a Google Sheet</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1f2933}</style><script src="/api/connectors/google-sheets/picker.js" defer></script></head><body><h1>Choose a Google Sheet</h1><p id="status">Opening Google's file picker…</p></body></html>`;

/** The page's script (served as JavaScript from this server). */
export const PICKER_SCRIPT = `/* EzyChat: Google's file picker for Google Sheets */
(function () {
  var token = new URLSearchParams(location.search).get('token') || '';
  var status = document.getElementById('status');
  var say = function (text) { status.textContent = text; };
  var send = function (body) {
    body.token = token;
    return fetch('/api/connectors/google-sheets/picker-result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  };
  fetch('/api/connectors/google-sheets/picker-config?token=' + encodeURIComponent(token))
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
          var view = new picker.DocsView(picker.ViewId.SPREADSHEETS).setMode(picker.DocsViewMode.LIST);
          new picker.PickerBuilder()
            .setAppId(cfg.appId)
            .setOAuthToken(cfg.oauthToken)
            .setDeveloperKey(cfg.developerKey)
            .setOrigin(location.origin)
            .addView(view)
            .setCallback(function (data) {
              if (data.action === picker.Action.PICKED && data.docs && data.docs[0]) {
                say('Checking the sheet…');
                send({ id: data.docs[0].id }).then(function (res) {
                  say(res.ok ? 'Done. Close this window and return to EzyChat.' : 'EzyChat could not open that sheet. Try again from EzyChat.');
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
    .catch(function () { say('This link expired. Choose the sheet again from EzyChat.'); });
})();
`;
