/**
 * Money installer. Runs as the person who opens it (not as the app's author), so everything it
 * creates lives in THEIR Google account: a "Money" Sheet with its own copy of the server, published
 * as their own web app. The author never gets access to their data.
 */
const REPO = 'https://raw.githubusercontent.com/manuqwert1234/money-tracker/main/';
const API = 'https://script.googleapis.com/v1/';

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Page').setTitle('Install Money')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function api_(method, path, payload) {
  const r = UrlFetchApp.fetch(API + path, {
    method, contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: payload ? JSON.stringify(payload) : undefined,
  });
  let j = {}; try { j = JSON.parse(r.getContentText() || '{}'); } catch (e) {}
  if (r.getResponseCode() >= 300) {
    const msg = (j.error && j.error.message) || r.getContentText();
    if (/not enabled|has not been used|is disabled|enable it/i.test(msg)) throw new Error('API_OFF');
    throw new Error(msg);
  }
  return j;
}

function file_(name) { return UrlFetchApp.fetch(REPO + name + '?t=' + Date.now()).getContentText(); }

/** Called from the page. Safe to call again: it continues where it stopped. */
function install() {
  const P = PropertiesService.getUserProperties();
  try {
    if (P.getProperty('URL')) return { ok: true, url: P.getProperty('URL'), again: true };
    let sheetId = P.getProperty('SHEET');
    if (!sheetId) { sheetId = SpreadsheetApp.create('Money').getId(); P.setProperty('SHEET', sheetId); }
    let scriptId = P.getProperty('SCRIPT');
    if (!scriptId) { scriptId = api_('post', 'projects', { title: 'Money', parentId: sheetId }).scriptId; P.setProperty('SCRIPT', scriptId); }
    api_('put', 'projects/' + scriptId + '/content', { files: [
      { name: 'appsscript', type: 'JSON', source: file_('template/appsscript.json') },
      { name: 'Code', type: 'SERVER_JS', source: file_('Code.gs') },
      { name: 'Index', type: 'HTML', source: file_('Index.html') },
    ] });
    const v = api_('post', 'projects/' + scriptId + '/versions', { description: 'Installed' });
    const dep = api_('post', 'projects/' + scriptId + '/deployments', { versionNumber: v.versionNumber, manifestFileName: 'appsscript', description: 'Money' });
    const url = ((dep.entryPoints || []).filter(e => e.entryPointType === 'WEB_APP')[0] || {}).webApp;
    if (!url || !url.url) throw new Error('Could not publish the app. Try again.');
    P.setProperty('URL', url.url);
    return { ok: true, url: url.url };
  } catch (e) {
    return String(e.message) === 'API_OFF' ? { ok: false, apiOff: true } : { ok: false, error: String(e.message || e) };
  }
}

/** Start over (e.g. if they deleted their Money sheet). */
function reset() { PropertiesService.getUserProperties().deleteAllProperties(); return { ok: true }; }
