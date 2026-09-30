/**
 * Money Tracker — reads bank SMS (sent by an iPhone Shortcut) and bank emails (Gmail),
 * stores transactions in this Google Sheet, and serves a phone dashboard.
 *
 * FIRST TIME: set PIN below, then run setup() once from the editor (Run ▸ setup).
 */

const CONFIG = {
  // PIN, budget, category limits and big-payment size are set inside the app (⚙️ Settings).
  // The values below are only the starting defaults.
  // Gmail search for bank alert emails. Add your bank's sender if you like, e.g. from:alerts@hdfcbank.net
  GMAIL_QUERY: 'newer_than:3d (debited OR credited OR spent OR "has been used" OR withdrawn)',
  TIMEZONE: 'Asia/Kolkata',
  MONTHLY_BUDGET: 20000,       // <-- how much you want to spend per month (₹)
  // Optional limits per category, e.g. { Food: 4000, Shopping: 3000 }
  CATEGORY_BUDGETS: { Food: 4000, Shopping: 3000 },
  BIG_PAYMENT: 5000,           // warn about any single payment at least this big
  EMAIL_ALERTS: true,          // email you at 9pm if you're overspending
};

// Keyword → category. First match wins. Add your own in the "Categories" tab of the Sheet.
const CATEGORY_RULES = [
  ['Food', /swiggy|zomato|restaurant|cafe|café|chai|\btea\b|coffee|swiggy insta|bakery|biryani|dominos|domino|pizza|mcdonald|kfc|burger|starbucks|haldiram|food|canteen|\bmess\b|hotel|dhaba|grand|bakes|eatclub|box8/i],
  ['Groceries', /blinkit|zepto|bigbasket|instamart|dmart|jiomart|grocer|kirana|supermarket|store|stores|\bfresh\b|\bmilk\b|dairy|vendolite|nature'?s basket|ratnadeep|more retail|spar|reliance smart/i],
  ['Transport', /uber|ola|rapido|\bmetro\b|irctc|railway|redbus|petrol|fuel|hpcl|iocl|bpcl|indian oil|shell|fastag|parking|namma yatri|bmtc|makemytrip|indigo|air india|\bcabs?\b|\bauto\b/i],
  ['Shopping', /amazon|flipkart|myntra|ajio|meesho|nykaa|croma|reliance digital|decathlon|ikea|lenskart|tata cliq|snapdeal|zara|h&m|mall/i],
  ['Bills & recharge', /airtel|jio|\bvi\b|vodafone|bsnl|recharge|electricity|bescom|tneb|msedcl|\bwater\b|\bgas\b|broadband|act fibernet|dth|tata ?play|insurance|\blic\b|\brent\b|society|\bemi\b|aws/i],
  ['Fun & subscriptions', /netflix|hotstar|spotify|prime|youtube|bookmyshow|pvr|inox|steam|playstation|xbox|apple|google play|sonyliv|zee5|gaming|dream11/i],
  ['Health', /pharma|medical|apollo|medplus|1mg|pharmeasy|netmeds|hospital|clinic|doctor|diagnostic|\blabs?\b|cult\.?fit|gym/i],
  ['Education', /college|school|university|course|udemy|coursera|\bfees?\b|exam|\bbooks?\b/i],
  ['Cash', /\batm\b|cash withdrawal|withdrawn/i],
];

function categorize_(merchant, message, custom) {
  const hay = (merchant || '') + ' ' + (message || '');
  for (const [kw, cat] of custom) if (kw && hay.toLowerCase().includes(kw)) return cat;
  for (const [cat, re] of CATEGORY_RULES) if (re.test(merchant || '')) return cat;
  if (!merchant) for (const [cat, re] of CATEGORY_RULES) if (re.test(message || '')) return cat;
  if (/@/.test(merchant || '') || /^[a-z .]+$/i.test(merchant || '')) return 'People (UPI)';
  return 'Other';
}

// ───────────────────────────── Settings (changed from the app) ─────────────────────────────

function settings_() {
  let saved = {};
  try { saved = JSON.parse(PropertiesService.getScriptProperties().getProperty('SETTINGS') || '{}'); } catch (e) {}
  return {
    budget: saved.budget != null ? Number(saved.budget) : CONFIG.MONTHLY_BUDGET,
    categoryBudgets: saved.categoryBudgets || CONFIG.CATEGORY_BUDGETS || {},
    bigPayment: saved.bigPayment != null ? Number(saved.bigPayment) : CONFIG.BIG_PAYMENT,
    emailAlerts: saved.emailAlerts != null ? !!saved.emailAlerts : CONFIG.EMAIL_ALERTS,
    balances: saved.balances || {},
  };
}

function pinOk_(pin) {
  const stored = PropertiesService.getScriptProperties().getProperty('PIN');
  return !!stored && String(pin) === stored;
}

function validPin_(pin) { return /^\d{4,8}$/.test(String(pin || '')); }

/** First time only: the app creates the PIN. After that it can only be changed with the old PIN. */
function createPin(pin) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('PIN')) return { ok: false, error: 'PIN already set' };
  if (!validPin_(pin)) return { ok: false, error: 'PIN must be 4–8 digits' };
  props.setProperty('PIN', String(pin));
  return { ok: true };
}

function saveSettings(pin, s) {
  if (!pinOk_(pin)) return { ok: false, error: 'Wrong PIN' };
  const props = PropertiesService.getScriptProperties();
  if (s.newPin) {
    if (!validPin_(s.newPin)) return { ok: false, error: 'PIN must be 4–8 digits' };
    props.setProperty('PIN', String(s.newPin));
  }
  const cats = {};
  for (const [k, v] of Object.entries(s.categoryBudgets || {})) if (k && Number(v) > 0) cats[String(k).slice(0, 40)] = Math.round(Number(v));
  const old = settings_();
  const balances = Object.assign({}, old.balances);
  for (const [k, v] of Object.entries(s.setBalances || {})) {
    if (v === '' || v === null) delete balances[k];
    else if (isFinite(Number(v))) balances[String(k).slice(0, 60)] = { value: Math.round(Number(v) * 100) / 100, at: Date.now() };
  }
  props.setProperty('SETTINGS', JSON.stringify({
    balances,
    budget: Math.max(0, Math.round(Number(s.budget) || 0)),
    categoryBudgets: cats,
    bigPayment: Math.max(0, Math.round(Number(s.bigPayment) || 0)),
    emailAlerts: !!s.emailAlerts,
  }));
  return { ok: true };
}

const SHEET_TX = 'Transactions';
const SHEET_UNPARSED = 'Unparsed';
const TX_HEADERS = ['When', 'Account', 'Kind', 'Type', 'Amount', 'Merchant', 'Balance', 'Source', 'Key', 'Message'];

// ───────────────────────────── Parser (pure, no Google services) ─────────────────────────────

const BANKS = [
  ['HDFC', /hdfc/i], ['SBI', /\bsbi\b|state bank/i], ['ICICI', /icici/i], ['Axis', /axis/i],
  ['Kotak', /kotak/i], ['PNB', /\bpnb\b|punjab national/i], ['BoB', /\bbob\b|bank of baroda/i],
  ['Canara', /canara/i], ['Union', /union bank/i], ['IDFC', /idfc/i], ['Yes', /yes bank/i],
  ['IndusInd', /indusind/i], ['Federal', /federal bank/i], ['AU', /\bau (small finance )?bank/i],
  ['IDBI', /idbi/i], ['Indian Bank', /indian bank/i], ['IOB', /\biob\b|indian overseas/i],
];

const NUM = '([\\d,]+(?:\\.\\d{1,2})?)';
const CUR = '(?:rs\\.?|inr|₹)';

function toNum_(s) { return Number(String(s).replace(/,/g, '')); }

/**
 * Returns {skip:reason} for non-transactions, null if it can't be understood,
 * or {type, amount, balance, account, kind, merchant, ref}.
 */
function parseBankMessage(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
  const low = t.toLowerCase();

  if (/\botp\b|one[- ]time password|verification code|\bpin\b.*\bgenerat/.test(low)) return { skip: 'otp' };
  if (/will be (debited|deducted|charged|auto)|is due|min(imum)?\.? (amt|amount)?\s*due|total (amt|amount )?due|due (date|on)|payment reminder|collect request|has requested|requested money|mandate (is )?(created|registered)|pre-?approved|eligible for|\bwin\b|cashback of|get up to|apply now|statement (is|for)/.test(low)) {
    return { skip: 'notice' };
  }

  // Which comes first decides debit vs credit ("debited ... transferred from" etc.)
  const debitRe = /\b(debited|debit(?:ed)? by|spent|sent|withdrawn|withdrawal|paid|purchase|used for|using your|txn of|dr\.?)\b/;
  const creditRe = /\b(credited|received|deposited|refund(?:ed)?|reversed|cr\.?)\b/;
  const d = low.search(debitRe), c = low.search(creditRe);
  if (d < 0 && c < 0) return null;
  const type = (d >= 0 && (c < 0 || d < c)) ? 'debit' : 'credit';

  // Balance / available limit first, then cut it out so it isn't mistaken for the amount.
  let rest = t, balance = null, limit = null;
  const limRe = new RegExp('(?:avl\\.?|avail(?:able)?\\.?)\\s*(?:credit\\s*)?(?:lmt|limit)\\s*(?:is|:|-)?\\s*' + CUR + '?\\s*:?\\s*' + NUM, 'i');
  const balRe = new RegExp('(?:avl\\.?|avail(?:able)?\\.?|avbl\\.?|clr|clear|total|a\\/c)?\\s*bal(?:ance)?\\.?\\s*(?:is|:)?\\s*(?:[-–]\\s+)?((?:-|−)(?!\\s))?\\s*' + CUR + '?\\s*:?\\s*((?:-|−)(?!\\s))?\\s*' + NUM + '(\\s*dr\\b)?', 'i');
  let m = rest.match(limRe);
  if (m) { limit = toNum_(m[1]); rest = rest.replace(m[0], ' '); }
  m = rest.match(balRe);
  if (m) { balance = toNum_(m[3]) * (m[1] || m[2] || m[4] ? -1 : 1); rest = rest.replace(m[0], ' '); }

  // Amount: "Rs 500", "INR 500", "₹500", or "debited by 500" / "credited with 500"
  let amount = null;
  m = rest.match(new RegExp(CUR + '\\s*' + NUM, 'i')) ||
      rest.match(new RegExp('(?:debited|credited)\\s*(?:by|with|for)?\\s*' + NUM, 'i'));
  if (m) amount = toNum_(m[1]);
  if (!amount || amount <= 0) return null;

  // Account: last digits after A/c / Acct / Card
  let last4 = '';
  const own = t.replace(/(sender|beneficiary|payee|remitter)(?:'s)?\s*(a\/c|acct|account)\s*(no\.?)?\s*[:\-]?\s*[x*.#]*\d{3,6}/ig, ' ');
  m = own.match(/(?:your|from your|to your)\s*(?:a\/c|acct|account)(?:\s*(?:no\.?|number|ending(?:\s*with)?))?\s*[:\-]?\s*[x*.#]*\s*(\d{3,6})\b/i) ||
      own.match(/(?:credited to|debited from)\s+(?:a\/c\s*)?[x*]{2,}(\d{3,6})\b/i);
  if (m) last4 = m[1].slice(-4);
  if (!last4) m = own.match(/(?:a\/c|acct|acc|account|card|\bac)(?:\s*(?:no\.?|number|ending(?:\s*with)?))?\s*[:\-]?\s*[x*.#]*\s*(\d{3,6})\b/i);
  if (!last4 && m) last4 = m[1].slice(-4);

  let bank = '';
  const noVpa = t.replace(/\S+@\S+/g, ' ');   // "okaxis" in a UPI id is not Axis Bank
  for (const [name, re] of BANKS) if (re.test(noVpa)) { bank = name; break; }

  if (!last4) return bank ? null : { skip: 'not a bank alert' };

  const isCard = /credit card/i.test(t) || (limit !== null && !/debit card/i.test(t));
  const kind = isCard ? 'card' : 'bank';
  const account = [bank || 'Bank', isCard ? 'Card' : 'A/c', last4 ? 'xx' + last4 : ''].join(' ').trim();

  m = t.match(/(?:ref(?:erence)?\.?\s*(?:no|number)?|refno|utr|rrn|txn\s*id|upi ref|upi)[\s:.#\-]*([a-z0-9]{6,})/i);
  const ref = m ? m[1] : '';

  // Merchant / person (best effort)
  const STOP = '(?=\\s+(?:on|ref|refno|upi|avl|avbl|if|not|via|thru|dated|at|from|with|\\d{1,2}[-\\/])\\b|[.;(]|\\s*-\\s*[A-Z]{2,}|$)';
  let merchant = '';
  m = t.match(/upi\*([a-z0-9 .&'\-]{2,40}?)(?=[.;*]|\s+(?:avl|on|ref)\b|$)/i) ||      // ICICI "InfoUPI*RAPIDO"
      t.match(/;\s*([a-z0-9 .&'\-]{2,40}?)\s+credited/i) ||                      // ICICI "...; ZOMATO credited"
      t.match(/\bvpa\s+([\w.\-]+@[\w]+)/i) ||                                     // UPI id
      t.match(new RegExp("(?:\\bat\\b|\\bto\\b|trf to|transfer to|towards|info[:\\-]?)\\s+([a-z0-9@._&'\\- ]{2,40}?)" + STOP, 'i'));
  if (!m && type === 'credit') m = t.match(new RegExp("\\bfrom\\s+([a-z0-9@._&'\\- ]{2,40}?)" + STOP, 'i')) ||
      t.match(new RegExp("(?:\\bby\\b)\\s+([a-z0-9@._&'\\- ]{2,40}?)" + STOP, 'i'));
  const clean = x => {
    x = (x || '').trim().replace(/^(a\/c|vpa|(by )?transfer from|from)\s+/i, '').replace(/\s+with$/i, '');
    return (/^(your|a\/c|ac|acc|acct|account|rs|inr|x+\d+)\b/i.test(x) || /unsubscribe|click|view|download|http/i.test(x) || /^[\d\s\/-]+$/.test(x)) ? '' : x;
  };
  if (m) merchant = clean(m[1]);
  if (!merchant && type === 'credit') {
    m = t.match(new RegExp("\\bfrom\\s+(?!your\\b)([a-z0-9@._&'\\- ]{2,40}?)" + STOP, 'i'));
    if (m) merchant = clean(m[1]);
  }
  // NEFT: "by Sender MICROSOFT GLOB..." → the company that paid you
  if (!merchant) { m = t.match(/by sender\s+([a-z0-9 .&'\-]{2,40}?)(?=,|\s+ifsc|$)/i); if (m) merchant = clean(m[1]); }

  return { type, amount, balance, limit, account, kind, merchant, ref };
}

// ───────────────────────────── Storage ─────────────────────────────

function sheet_(name, headers) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  }
  return sh;
}

function day_(date) { return Utilities.formatDate(date, CONFIG.TIMEZONE, 'yyyy-MM-dd'); }

/** Saves one message. Returns 'added' | 'duplicate' | 'skipped' | 'unparsed'. */
function ingest_(text, source, when) {
  return ingestMany_([{ text, source, when }])[0];
}

/**
 * Saves many messages at once (fast enough for importing years of history).
 * The same payment often arrives by SMS *and* email. With a ref number, match on that.
 * Without one, match amount+account+day against the *other* source, or the exact same
 * message time (so re-reading an email is ignored, but two real ₹20 chai payments are kept).
 */
function ingestMany_(items) {
  const sh = sheet_(SHEET_TX, TX_HEADERS);
  const existing = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 9).getValues() : [];
  const seen = new Map();   // key → [{src, t}]
  const remember = (k, src, t) => { if (!seen.has(k)) seen.set(k, []); seen.get(k).push({ src, t }); };
  for (const r of existing) remember(r[8], r[7], new Date(r[0]).getTime());

  const newRows = [], unparsed = [], results = [];
  for (const it of items) {
    const when = it.when ? new Date(it.when) : new Date();
    const text = String(it.text || '');
    const p = parseBankMessage(text);
    if (p && p.skip) { results.push('skipped'); continue; }
    if (!p) {
      // Only log things that look like money movements, so promos don't flood it.
      if (/debit|credit|spent|withdraw|rs\.?\s?\d|inr\s?\d|₹/i.test(text)) { unparsed.push([when, it.source, text.slice(0, 1500)]); results.push('unparsed'); }
      else results.push('skipped');
      continue;
    }
    const key = p.ref ? 'ref:' + p.ref : [p.account, p.type, p.amount, day_(when)].join('|');
    const t = when.getTime();
    const dup = (seen.get(key) || []).some(e => p.ref || e.src !== it.source || Math.abs(e.t - t) < 1000);
    if (dup) { results.push('duplicate'); continue; }
    remember(key, it.source, t);
    newRows.push([when, p.account, p.kind, p.type, p.amount, p.merchant, p.balance !== null ? p.balance : (p.limit !== null ? p.limit : ''), it.source, key, text.slice(0, 1500)]);
    results.push('added');
  }
  if (newRows.length) sh.getRange(sh.getLastRow() + 1, 1, newRows.length, TX_HEADERS.length).setValues(newRows);
  if (unparsed.length) { const u = sheet_(SHEET_UNPARSED, ['When', 'Source', 'Message']); u.getRange(u.getLastRow() + 1, 1, unparsed.length, 3).setValues(unparsed); }
  return results;
}

// ───────────────────────────── Entry points ─────────────────────────────

/** iPhone Shortcut POSTs {"token": "...", "text": "<the SMS>"} here. */
function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad json' }); }
  // The phone app asks for its numbers here (text/plain POST, so no CORS preflight).
  if (body.action === 'summary') return json_(getSummary(body.pin));
  if (body.action === 'createPin') return json_(createPin(body.newPin));
  if (body.action === 'saveSettings') return json_(saveSettings(body.pin, body.settings || {}));
  if (body.action === 'add') return json_({ ok: true, result: addManual(body.pin, body.text || '') });

  const secret = PropertiesService.getScriptProperties().getProperty('SECRET');
  if (!secret || body.token !== secret) return json_({ ok: false, error: 'bad token' });
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return json_({ ok: true, result: ingest_(body.text || '', body.source || 'sms') });
  } finally {
    lock.releaseLock();
  }
}

/** The dashboard page. It shows nothing until the right PIN is entered. */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Money')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Runs every 10 minutes: reads new bank emails. */
function scanGmail() {
  const props = PropertiesService.getScriptProperties();
  const seen = new Set(JSON.parse(props.getProperty('SEEN') || '[]'));
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    for (const thread of GmailApp.search(CONFIG.GMAIL_QUERY, 0, 50)) {
      for (const msg of thread.getMessages()) {
        const id = msg.getId();
        if (seen.has(id)) continue;
        seen.add(id);
        ingest_(msg.getSubject() + '. ' + msg.getPlainBody(), 'email', msg.getDate());
      }
    }
  } finally {
    lock.releaseLock();
  }
  props.setProperty('SEEN', JSON.stringify([...seen].slice(-800)));
}

function customCategories_() {
  const sh = SpreadsheetApp.getActive().getSheetByName('Categories');
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues()
    .filter(r => r[0] && r[1]).map(r => [String(r[0]).toLowerCase().trim(), String(r[1]).trim()]);
}

/** All the numbers behind the dashboard and the alerts. */
function buildSummary_() {
  const sh = sheet_(SHEET_TX, TX_HEADERS);
  const n = sh.getLastRow() - 1;
  const rows = n > 0 ? sh.getRange(2, 1, n, 10).getValues() : [];
  rows.sort((a, b) => new Date(a[0]) - new Date(b[0]));
  const custom = customCategories_();
  const tz = CONFIG.TIMEZONE;
  const S = settings_();
  const fmt = (d, f) => Utilities.formatDate(new Date(d), tz, f);

  const now = new Date();
  const thisMonth = fmt(now, 'yyyy-MM');
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  const lastMonth = fmt(lastMonthDate, 'yyyy-MM');
  const today = Number(fmt(now, 'd'));
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const todayKey = fmt(now, 'yyyy-MM-dd');

  const accounts = {};
  let spent = 0, received = 0, lastMonthSoFar = 0, lastMonthTotal = 0, spentToday = 0;
  const daily = Array(daysInMonth).fill(0);
  const byCat = {}, byCatLast = {}, byMerchant = {};
  const big = [];
  const past30 = {};   // day → spend, for "usual" daily spend

  const manual = S.balances || {};   // { account: { value, at } } set by you in Settings
  const r2m = x => Math.round(x * 100) / 100;
  for (const [when, account, kind, type, amount, merchant, balance, , , message] of rows) {
    const a = accounts[account] || (accounts[account] = { name: account, kind, balance: null, flow: 0, updated: null, since: 0, estimated: false });
    const t = new Date(when).getTime(), delta = type === 'credit' ? amount : -amount;
    a.flow = r2m(a.flow + delta);
    const man = manual[account];
    if (balance !== '' && balance !== null && kind !== 'card' && !(man && man.at > t)) {
      a.balance = Number(balance); a.balanceAt = new Date(when).toISOString(); a.since = 0; a.estimated = false; a.manual = false;
    } else if (a.balance !== null && kind !== 'card' && !(man && man.at > t)) {
      a.balance = r2m(a.balance + delta); a.since++; a.estimated = true;   // no balance in this message: work it out
    } else if (kind === 'card' && balance !== '' && balance !== null) a.balance = Number(balance);
    a.updated = new Date(when).toISOString();

    const m = fmt(when, 'yyyy-MM'), day = Number(fmt(when, 'd'));
    if (type === 'credit') { if (m === thisMonth) received += amount; continue; }

    const cat = categorize_(merchant, message, custom);
    const ageDays = (now - new Date(when)) / 86400000;
    if (ageDays <= 30 && fmt(when, 'yyyy-MM-dd') !== todayKey) past30[fmt(when, 'yyyy-MM-dd')] = (past30[fmt(when, 'yyyy-MM-dd')] || 0) + amount;

    if (m === thisMonth) {
      spent += amount;
      daily[day - 1] += amount;
      byCat[cat] = (byCat[cat] || 0) + amount;
      const who = merchant || cat;
      byMerchant[who] = (byMerchant[who] || 0) + amount;
      if (fmt(when, 'yyyy-MM-dd') === todayKey) spentToday += amount;
      if (S.bigPayment > 0 && amount >= S.bigPayment) big.push({ when: new Date(when).toISOString(), amount, merchant: merchant || cat });
    } else if (m === lastMonth) {
      lastMonthTotal += amount;
      if (day <= today) { lastMonthSoFar += amount; byCatLast[cat] = (byCatLast[cat] || 0) + amount; }
    }
  }

  for (const [name, man] of Object.entries(manual)) {
    const a = accounts[name]; if (!a || !man || man.value === null || man.value === undefined) continue;
    // bank sent a real balance after you typed yours → that one wins (already worked out above)
    if (a.balanceAt && new Date(a.balanceAt).getTime() > man.at) continue;
    const after = rows.filter(r => r[1] === name && new Date(r[0]).getTime() > man.at).reduce((s, r) => s + (r[3] === 'credit' ? r[4] : -r[4]), 0);
    a.balance = r2m(Number(man.value) + after); a.balanceAt = new Date(man.at).toISOString(); a.estimated = after !== 0; a.manual = true;
  }

  const projected = today > 0 ? Math.round(spent / today * daysInMonth) : 0;
  const budget = S.budget;
  const daysLeft = daysInMonth - today + 1;
  const safeToSpendPerDay = Math.max(0, Math.round((budget - spent + spentToday) / daysLeft));
  const usualDays = Object.values(past30);
  const usualPerDay = usualDays.length ? Math.round(usualDays.reduce((x, y) => x + y, 0) / 30) : 0;

  // ── Alerts (most serious first) ──
  const inr = x => '₹' + Math.round(x).toLocaleString('en-IN');
  const alerts = [];
  if (spent > budget) alerts.push({ level: 'critical', text: `You've gone over your ${inr(budget)} budget by ${inr(spent - budget)} this month.` });
  else if (projected > budget * 1.05 && today >= 5) alerts.push({ level: 'warning', text: `At this pace you'll spend about ${inr(projected)} this month, which is ${inr(projected - budget)} over your budget. Try to keep to ${inr(safeToSpendPerDay)} a day.` });
  for (const [cat, lim] of Object.entries(S.categoryBudgets)) {
    const v = byCat[cat] || 0;
    if (v > lim) alerts.push({ level: 'critical', text: `${cat}: ${inr(v)} spent. Your limit is ${inr(lim)}.` });
    else if (v > lim * 0.8) alerts.push({ level: 'warning', text: `${cat}: ${inr(v)} of your ${inr(lim)} limit used already.` });
  }
  for (const [cat, v] of Object.entries(byCat)) {
    const was = byCatLast[cat] || 0;
    if (was > 0 && v > was * 1.4 && v - was >= 500) alerts.push({ level: 'warning', text: `${cat} is up ${Math.round((v / was - 1) * 100)}% compared with this point last month (${inr(v)} vs ${inr(was)}).` });
  }
  if (usualPerDay > 0 && spentToday > usualPerDay * 2 && spentToday >= 500) alerts.push({ level: 'warning', text: `You spent ${inr(spentToday)} today, more than twice your usual ${inr(usualPerDay)} a day.` });
  for (const b of big.slice(-3)) alerts.push({ level: 'info', text: `Big payment: ${inr(b.amount)} to ${b.merchant}.` });
  if (!alerts.length && spent > 0) alerts.push({ level: 'good', text: `You're on track: ${inr(spent)} spent, ${inr(Math.max(0, budget - spent))} left for ${daysLeft} day(s).` });

  const sortObj = o => Object.entries(o).sort((x, y) => y[1] - x[1]);
  const r2 = x => Math.round(x * 100) / 100;   // keep paise, drop float noise
  const unparsed = SpreadsheetApp.getActive().getSheetByName(SHEET_UNPARSED);
  return {
    ok: true,
    accounts: Object.values(accounts),
    spent: r2(spent), received: r2(received), spentToday: r2(spentToday), budget, projected, safeToSpendPerDay, usualPerDay,
    lastMonthSoFar: r2(lastMonthSoFar), lastMonthTotal: r2(lastMonthTotal), today, daysInMonth,
    daily: daily.map(r2),
    categories: sortObj(byCat).map(([name, v]) => ({ name, value: r2(v), last: r2(byCatLast[name] || 0), limit: S.categoryBudgets[name] || null })),
    merchants: sortObj(byMerchant).slice(0, 6).map(([name, v]) => ({ name, value: r2(v) })),
    alerts,
    recent: rows.slice(-40).reverse().map(r => ({
      when: new Date(r[0]).toISOString(), account: r[1], type: r[3], amount: r[4], merchant: r[5],
      category: r[3] === 'debit' ? categorize_(r[5], r[9], custom) : 'Money in',
    })),
    unparsed: unparsed ? Math.max(0, unparsed.getLastRow() - 1) : 0,
    settings: S,
    // Every transaction, compact: [time, account, type(1=in,0=out), amount, merchant, balance|null, category]
    history: rows.map(r => [new Date(r[0]).getTime(), r[1], r[3] === 'credit' ? 1 : 0, r[4], r[5] || '',
      r[6] === '' || r[6] === null || r[2] === 'card' ? null : Number(r[6]), r[3] === 'debit' ? categorize_(r[5], r[9], custom) : 'Money in']),
    allCategories: CATEGORY_RULES.map(r => r[0]).concat(['People (UPI)', 'Other']),
  };
}

/**
 * Imports ALL your old bank emails (last 3 years). Run it once from the editor: Run ▸ importHistory.
 * Google stops scripts after 6 minutes, so it saves its place and carries on by itself every minute until done.
 */
function importHistory() {
  const props = PropertiesService.getScriptProperties();
  const started = Date.now();
  let start = Number(props.getProperty('IMPORT_AT') || 0);
  let added = Number(props.getProperty('IMPORT_ADDED') || 0);
  const query = 'newer_than:3y (debited OR credited OR spent OR "has been used" OR withdrawn OR "transaction alert")';
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    while (Date.now() - started < 4.5 * 60 * 1000) {
      const threads = GmailApp.search(query, start, 100);
      if (!threads.length) {
        props.deleteProperty('IMPORT_AT'); props.deleteProperty('IMPORT_ADDED');
        ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'importHistory').forEach(t => ScriptApp.deleteTrigger(t));
        Logger.log('✅ Import finished. Added ' + added + ' transactions from your old emails.');
        return;
      }
      const items = [];
      for (const th of threads) for (const m of th.getMessages()) items.push({ text: m.getSubject() + '. ' + m.getPlainBody(), source: 'email', when: m.getDate() });
      added += ingestMany_(items).filter(r => r === 'added').length;
      start += threads.length;
      props.setProperty('IMPORT_AT', String(start)); props.setProperty('IMPORT_ADDED', String(added));
      Logger.log('…read ' + start + ' email threads, added ' + added + ' transactions so far');
    }
  } finally { lock.releaseLock(); }
  // Not done yet: continue in a minute.
  if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'importHistory')) ScriptApp.newTrigger('importHistory').timeBased().everyMinutes(1).create();
  Logger.log('⏳ Still importing. It carries on by itself every minute. You can close this.');
}

/** Clears the imported emails and reads them again with the latest reader. SMS & manual rows are kept. */
function rebuildFromEmails() {
  const sh = sheet_(SHEET_TX, TX_HEADERS);
  if (sh.getLastRow() > 1) {
    const keep = sh.getRange(2, 1, sh.getLastRow() - 1, TX_HEADERS.length).getValues().filter(r => r[7] !== 'email');
    sh.getRange(2, 1, sh.getLastRow() - 1, TX_HEADERS.length).clearContent();
    if (keep.length) sh.getRange(2, 1, keep.length, TX_HEADERS.length).setValues(keep);
  }
  const u = sheet_(SHEET_UNPARSED, ['When', 'Source', 'Message']);
  if (u.getLastRow() > 1) u.getRange(2, 1, u.getLastRow() - 1, 3).clearContent();
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('IMPORT_AT'); props.deleteProperty('IMPORT_ADDED'); props.deleteProperty('SEEN');
  importHistory();
}

/** Called by the dashboard. */
function getSummary(pin) {
  if (!PropertiesService.getScriptProperties().getProperty('PIN')) return { ok: false, needsPin: true };
  if (!pinOk_(pin)) return { ok: false };
  return buildSummary_();
}

/** Runs every evening: emails you only if something needs attention. */
function dailyCheck() {
  if (!settings_().emailAlerts) return;
  const d = buildSummary_();
  const serious = d.alerts.filter(a => a.level === 'critical' || a.level === 'warning');
  if (!serious.length) return;
  const inr = x => '₹' + Math.round(x).toLocaleString('en-IN');
  const body = [
    `Spent this month: ${inr(d.spent)} of ${inr(d.budget)}`,
    `Today: ${inr(d.spentToday)} · Safe to spend: ${inr(d.safeToSpendPerDay)}/day`,
    '',
    ...serious.map(a => (a.level === 'critical' ? '🔴 ' : '🟠 ') + a.text),
    '',
    'Open your Money app for details: ' + ScriptApp.getService().getUrl(),
  ].join('\n');
  MailApp.sendEmail(Session.getEffectiveUser().getEmail(), `💸 Money alert: ${serious[0].text.slice(0, 60)}`, body);
}

/** Lets you paste an old SMS in the app to add it by hand. */
function addManual(pin, text) {
  if (!pinOk_(pin)) return 'bad pin';
  return ingest_(text, 'manual');
}

/** RUN THIS ONCE. Creates sheets, the Gmail timer, and your secret token. */
function setup() {
  sheet_(SHEET_TX, TX_HEADERS);
  sheet_(SHEET_UNPARSED, ['When', 'Source', 'Message']);
  const cats = sheet_('Categories', ['If the shop/person contains…', 'Put it in category']);
  if (cats.getLastRow() < 2) cats.appendRow(['ramesh', 'Rent']);   // example: edit or delete
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SECRET')) props.setProperty('SECRET', Utilities.getUuid().replace(/-/g, ''));
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('scanGmail').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('dailyCheck').timeBased().everyDays(1).atHour(21).inTimezone(CONFIG.TIMEZONE).create();
  Logger.log('Your secret token for the iPhone Shortcut:  ' + props.getProperty('SECRET'));
}



/** Forgot your PIN? Run this from the editor (Run ▸ resetPin). Next time you open the app it asks you to create a new one. */
function resetPin() {
  PropertiesService.getScriptProperties().deleteProperty('PIN');
  Logger.log('PIN cleared. Open the app now and create a new PIN.');
}

if (typeof module !== 'undefined') module.exports = { parseBankMessage, categorize_ };
