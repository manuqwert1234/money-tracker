/**
 * "On this phone" mode: runs the same Money code (core.js = Code.gs) inside the app, with the
 * Google services it uses replaced by small stand-ins that keep everything in this phone's storage.
 * No Google account, no server. Used by the Android app when you choose "Start" instead of signing in.
 */
(function () {
  const PFX = 'L_';
  const ls = {
    get: k => { try { return localStorage.getItem(PFX + k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(PFX + k, v); } catch (e) {} },
    del: k => { try { localStorage.removeItem(PFX + k); } catch (e) {} },
  };

  // ── Sheets → arrays saved in this phone's storage ──
  const sheets = {};
  function loadSheet(name) {
    let rows = [];
    try { rows = JSON.parse(ls.get('sheet:' + name) || '[]'); } catch (e) {}
    rows.forEach((r, i) => { if (i > 0 && r[0]) r[0] = new Date(r[0]); });   // first column is a date
    return rows;
  }
  let saveTimer = null;
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveAll, 50); }
  function saveAll() { for (const [n, sh] of Object.entries(sheets)) ls.set('sheet:' + n, JSON.stringify(sh.rows.map(r => r.map(v => v instanceof Date ? v.toISOString() : v)))); }
  function makeSheet(name, rows) {
    const sh = {
      rows,
      getLastRow: () => sh.rows.length,
      setFrozenRows() {},
      appendRow(r) { sh.rows.push(r.slice()); scheduleSave(); },
      getRange(r, c, n, w) {
        n = n || 1; w = w || 1;
        return {
          getValues: () => sh.rows.slice(r - 1, r - 1 + n).map(row => { const out = []; for (let j = 0; j < w; j++) out.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]); return out; }),
          setValues(v) { v.forEach((row, i) => { const target = sh.rows[r - 1 + i] || (sh.rows[r - 1 + i] = []); row.forEach((x, j) => target[c - 1 + j] = x); }); scheduleSave(); },
          setValue(x) { (sh.rows[r - 1] || (sh.rows[r - 1] = []))[c - 1] = x; scheduleSave(); },
          clearContent() { sh.rows.splice(r - 1, n); scheduleSave(); },
        };
      },
    };
    return sh;
  }
  const book = {
    getSheetByName(n) { if (sheets[n]) return sheets[n]; const rows = loadSheet(n); if (!rows.length) return null; return (sheets[n] = makeSheet(n, rows)); },
    insertSheet(n) { return (sheets[n] = makeSheet(n, [])); },
    getSpreadsheetTimeZone: () => 'Asia/Kolkata', setSpreadsheetTimeZone() {},
  };
  window.SpreadsheetApp = { getActive: () => book };

  // ── Properties → phone storage ──
  const props = {
    getProperty: k => ls.get('p:' + k), setProperty: (k, v) => ls.set('p:' + k, String(v)),
    deleteProperty: k => ls.del('p:' + k), deleteAllProperties() {},
  };
  window.PropertiesService = { getScriptProperties: () => props, getUserProperties: () => props };
  window.LockService = { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) };
  window.CacheService = { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) };
  window.ScriptApp = { getService: () => ({ getUrl: () => '' }), getProjectTriggers: () => [] };

  // ── Utilities: dates in India time, ids ──
  const TZ = 'Asia/Kolkata';
  const parts = d => { const o = {}; new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' })
    .formatToParts(new Date(d)).forEach(p => o[p.type] = p.value); return o; };
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  window.Utilities = {
    formatDate(d, tz, f) {
      const p = parts(d), h24 = Number(p.hour) % 24, h12 = (h24 % 12) || 12, ap = h24 < 12 ? 'AM' : 'PM';
      return f.replace(/yyyy|MMM|MM|dd|EEE|d|HH|h|mm|a/g, t => ({ yyyy: p.year, MMM: MON[Number(p.month) - 1], MM: p.month, dd: p.day, EEE: p.weekday, d: String(Number(p.day)), HH: String(h24).padStart(2, '0'), h: String(h12), mm: p.minute, a: ap }[t]));
    },
    getUuid: () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()),
  };
  window.Session = { getEffectiveUser: () => ({ getEmail: () => '' }), getActiveUser: () => ({ getEmail: () => '' }) };
  window.Logger = { log() {} };

  // ── The app's API, answered on the phone ──
  window.LocalMoney = {
    ready() { if (!props.getProperty('PIN')) { props.setProperty('PIN', 'local'); props.setProperty('SECRET', 'local'); } },
    call(action, body) {
      LocalMoney.ready();
      if (action === 'summary') return getSummary('local');
      if (action === 'saveSettings') return saveSettings('local', body.settings || {});
      if (action === 'setCategory') return setCategory('local', body.merchant, body.category);
      if (action === 'add') return { ok: true, result: addManual('local', body.text || '') };
      if (action === 'refresh') return { ok: true, added: 0 };
      return { ok: false, error: 'Not available on this phone' };
    },
    /** texts from the Android app: [{text, when}] */
    ingest(items) { LocalMoney.ready(); const r = ingestMany_(items.map(x => ({ text: String(x.text || ''), source: 'sms', when: new Date(Number(x.when) || Date.now()) }))); saveAll(); return r.filter(x => x === 'added').length; },
  };
})();
